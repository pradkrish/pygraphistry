import parser from './expression-parser.pegjs';
import { parse as parseUtil } from 'pegjs-util';
import { print as printExpression } from './expression-printer';
import {
    ref as $ref,
    atom as $atom,
    pathValue as $value
} from '@graphistry/falcor-json-graph';

import { simpleflake } from 'simpleflakes';
// import { sets } from './sets';
import { filters } from './filters';
import { exclusions } from './exclusions';
import { histograms } from './histograms';

export function expressions(view) {

    const defaultFilter = expression('LIMIT 800000');
    defaultFilter.expressionType = 'filter';
    defaultFilter.level = 'system';

    return {
        // ...sets(workbookId, viewId),
        ...exclusions(view),
        ...histograms(view),
        ...filters(view, defaultFilter),
        expressionTemplates: [],
        expressionsById: {
            [defaultFilter.id]: {
                ...defaultFilter
            }
        }
    };
}

export function expression(inputOrProps = {
                                name: 'degree',
                                dataType: 'number',
                                componentType: 'point'
                           },
                           expressionId = simpleflake().toJSON()) {

    let name = '',
        input = '',
        query = '',
        dataType = '',
        identifier = '',
        componentType = '';

    if (typeof inputOrProps === 'string') {
        query = parseUtil(parser, inputOrProps, { startRule: 'start' });
    } else if (inputOrProps && typeof inputOrProps === 'object') {
        name = inputOrProps.name || 'degree';
        dataType = inputOrProps.dataType || 'number';
        componentType = inputOrProps.componentType || 'point';
        identifier = `${componentType}:${name}`;
        query = getDefaultQueryForDataType({
            ...inputOrProps, name, dataType, identifier, componentType
        });
    }

    input = printExpression(query);

    return {
        id: expressionId,
        enabled: true,
        level: undefined, /* <-- 'system' | undefined */
        name, input, query,
        dataType, identifier, componentType, /* 'edge' | 'point' */
        expressionType: 'filter', /* <-- 'filter' | 'exclusion' */
    };
}

export function getDefaultQueryForDataType(queryProperties = {}) {
    const { dataType = 'number', identifier } = queryProperties;
    const queryFactory = defaultQueriesMap[dataType] || defaultQueriesMap.literal;
    return {
        dataType, attribute: identifier,
        ...queryFactory(queryProperties)
    };
}

const defaultQueriesMap = {
    float(...args) {
        return this.number(...args)
    },
    integer(...args) {
        return this.number(...args)
    },
    number({ identifier, start = 0 }) {
        return {
            start, ast: {
                type: 'BinaryExpression',
                operator: '>=',
                left: { type: 'Identifier', name: identifier },
                right: { type: 'Literal', value: start }
            }
        };
    },
    categorical(...args) {
        return this.string(...args);
    },
    string({ identifier, equals = 'ABC' }) {
        return {
            equals, ast: {
                type: 'BinaryExpression',
                operator: '=',
                left: { type: 'Identifier', name: identifier },
                right: { type: 'Literal', value: equals }
            }
        };
    },
    boolean({ identifier, equals = true }) {
        return {
            ast: {
                type: 'BinaryPredicate',
                operator: 'IS',
                left: { type: 'Identifier', name: identifier },
                right: { type: 'Literal', value: equals }
            }
        }
    },
    datetime(...args) {
        return this.date(...args);
    },
    date({ identifier }) {
        return {
            ast: {
                type: 'BinaryExpression',
                operator: '>=',
                left: { type: 'Identifier', name: identifier },
                right: { type: 'Literal', value: 'now'}
            }
        };
    },
    literal({ identifier, value = true }) {
        return {
            ast: {
                value, type: 'Literal',
            }
        }
    }
};
