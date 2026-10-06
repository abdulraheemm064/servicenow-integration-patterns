/**
 * CBPayloadValidator - small, dependency-free validator for JSON payloads.
 *
 * Supports a deliberately small subset of JSON-Schema-like keywords that cover
 * most integration contracts: type, required, properties, additionalProperties,
 * enum, pattern, minLength, maxLength, minimum, maximum, items, maxItems.
 *
 *   var result = new CBPayloadValidator(schema).validate(payload);
 *   if (!result.valid) { ... result.errors[0].path / .message ... }
 */
var CBPayloadValidator = Class.create();

CBPayloadValidator.typeOf = function (value) {
    if (value === null) {
        return 'null';
    }
    if (Object.prototype.toString.call(value) === '[object Array]') {
        return 'array';
    }
    if (typeof value === 'number') {
        return value % 1 === 0 ? 'integer' : 'number';
    }
    return typeof value;
};

CBPayloadValidator.prototype = {
    initialize: function (schema) {
        if (!schema || typeof schema !== 'object') {
            throw new Error('CBPayloadValidator: schema object is required');
        }
        this.schema = schema;
    },

    validate: function (payload) {
        var errors = [];
        this._check(payload, this.schema, '$', errors);
        return { valid: errors.length === 0, errors: errors };
    },

    _typeMatches: function (expected, actual) {
        if (expected === actual) {
            return true;
        }
        return expected === 'number' && actual === 'integer';
    },

    _check: function (value, schema, path, errors) {
        var actual = CBPayloadValidator.typeOf(value);
        var i;

        if (schema.type && !this._typeMatches(schema.type, actual)) {
            errors.push({ path: path, message: 'expected ' + schema.type + ' but got ' + actual });
            return;
        }
        if (schema['enum']) {
            var allowed = false;
            for (i = 0; i < schema['enum'].length; i++) {
                if (schema['enum'][i] === value) {
                    allowed = true;
                }
            }
            if (!allowed) {
                errors.push({ path: path, message: 'must be one of: ' + schema['enum'].join(', ') });
            }
        }
        if (actual === 'string') {
            if (schema.minLength !== undefined && value.length < schema.minLength) {
                errors.push({ path: path, message: 'must be at least ' + schema.minLength + ' characters' });
            }
            if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                errors.push({ path: path, message: 'must be at most ' + schema.maxLength + ' characters' });
            }
            if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
                errors.push({ path: path, message: 'does not match pattern ' + schema.pattern });
            }
        }
        if (actual === 'number' || actual === 'integer') {
            if (schema.minimum !== undefined && value < schema.minimum) {
                errors.push({ path: path, message: 'must be >= ' + schema.minimum });
            }
            if (schema.maximum !== undefined && value > schema.maximum) {
                errors.push({ path: path, message: 'must be <= ' + schema.maximum });
            }
        }
        if (actual === 'array') {
            if (schema.maxItems !== undefined && value.length > schema.maxItems) {
                errors.push({ path: path, message: 'must contain at most ' + schema.maxItems + ' items' });
            }
            if (schema.items) {
                for (i = 0; i < value.length; i++) {
                    this._check(value[i], schema.items, path + '[' + i + ']', errors);
                }
            }
        }
        if (actual === 'object') {
            var required = schema.required || [];
            var missing = {};
            for (i = 0; i < required.length; i++) {
                if (value[required[i]] === undefined || value[required[i]] === null || value[required[i]] === '') {
                    missing[required[i]] = true;
                    errors.push({ path: path + '.' + required[i], message: 'is required' });
                }
            }
            var props = schema.properties || {};
            for (var key in value) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) {
                    continue;
                }
                if (props[key]) {
                    if (value[key] !== undefined && value[key] !== null && !missing[key]) {
                        this._check(value[key], props[key], path + '.' + key, errors);
                    }
                } else if (schema.additionalProperties === false) {
                    errors.push({ path: path + '.' + key, message: 'is not an allowed property' });
                }
            }
        }
    },

    type: 'CBPayloadValidator'
};
