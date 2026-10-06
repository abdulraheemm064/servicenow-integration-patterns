/**
 * CBCoalesceHelper - transform-map style "coalesce" upsert for scripted loads.
 *
 * Use it when data arrives through a Scripted REST API or a scheduled pull
 * rather than an Import Set, but you still want transform-map behaviour:
 *
 *   var helper = new CBCoalesceHelper('x_cbk_int_account', {
 *       coalesce: ['account_number'],
 *       fieldMap: { accountNumber: 'account_number', status: 'status', ccy: 'currency' },
 *       transforms: { status: CBCoalesceHelper.lower, currency: CBCoalesceHelper.upper }
 *   });
 *   var r = helper.upsert(sourceRow);   // { action: 'insert'|'update'|'skip'|'error', sysId, changed }
 *
 * - Coalesce fields must all be present; otherwise the row is rejected (an
 *   empty coalesce value would match or create the wrong record).
 * - If more than one target record matches, the row is rejected and not
 *   updated: ambiguous coalesce is a data quality problem to fix, not guess.
 * - Unchanged rows are skipped to avoid needless updates, audit noise and
 *   business-rule executions.
 */
var CBCoalesceHelper = Class.create();

CBCoalesceHelper.trim = function (v) { return v === null || v === undefined ? '' : String(v).replace(/^\s+|\s+$/g, ''); };
CBCoalesceHelper.upper = function (v) { return CBCoalesceHelper.trim(v).toUpperCase(); };
CBCoalesceHelper.lower = function (v) { return CBCoalesceHelper.trim(v).toLowerCase(); };

CBCoalesceHelper.prototype = {
    initialize: function (table, config) {
        if (!table || !config || !config.coalesce || !config.coalesce.length || !config.fieldMap) {
            throw new Error('CBCoalesceHelper: table, coalesce and fieldMap are required');
        }
        this.table = table;
        this.coalesce = config.coalesce;
        this.fieldMap = config.fieldMap;
        this.transforms = config.transforms || {};
        this.logger = config.logger || new CBLogger('CBCoalesceHelper');
    },

    mapRow: function (row) {
        var target = {};
        for (var src in this.fieldMap) {
            if (Object.prototype.hasOwnProperty.call(this.fieldMap, src) && row[src] !== undefined) {
                var field = this.fieldMap[src];
                var fn = this.transforms[field] || CBCoalesceHelper.trim;
                target[field] = fn(row[src]);
            }
        }
        return target;
    },

    upsert: function (row) {
        var values = this.mapRow(row || {});
        var i;
        for (i = 0; i < this.coalesce.length; i++) {
            if (!values[this.coalesce[i]]) {
                return { action: 'error', message: 'coalesce field ' + this.coalesce[i] + ' is empty' };
            }
        }

        var gr = new GlideRecord(this.table);
        for (i = 0; i < this.coalesce.length; i++) {
            gr.addQuery(this.coalesce[i], values[this.coalesce[i]]);
        }
        gr.setLimit(2);
        gr.query();
        var matches = 0;
        var matchId = null;
        while (gr.next()) {
            matches++;
            matchId = gr.getUniqueValue();
        }
        if (matches > 1) {
            this.logger.warn('coalesce.ambiguous', { table: this.table, coalesce: this._coalesceValues(values) });
            return { action: 'error', message: 'more than one record matches the coalesce fields' };
        }

        var target = new GlideRecord(this.table);
        if (matches === 1) {
            target.get(matchId);
            var changed = [];
            for (var field in values) {
                if (Object.prototype.hasOwnProperty.call(values, field) && target.getValue(field) !== values[field]) {
                    changed.push(field);
                    target.setValue(field, values[field]);
                }
            }
            if (!changed.length) {
                return { action: 'skip', sysId: matchId, changed: [] };
            }
            target.update();
            return { action: 'update', sysId: matchId, changed: changed };
        }

        target.initialize();
        for (var f in values) {
            if (Object.prototype.hasOwnProperty.call(values, f)) {
                target.setValue(f, values[f]);
            }
        }
        var sysId = target.insert();
        return { action: 'insert', sysId: sysId, changed: [] };
    },

    _coalesceValues: function (values) {
        var out = {};
        for (var i = 0; i < this.coalesce.length; i++) {
            out[this.coalesce[i]] = values[this.coalesce[i]];
        }
        return out;
    },

    type: 'CBCoalesceHelper'
};
