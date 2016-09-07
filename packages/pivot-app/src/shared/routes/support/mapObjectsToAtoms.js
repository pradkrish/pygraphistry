import Color from 'color';
import { atom as $atom } from '@graphistry/falcor-json-graph';

export function mapObjectsToAtoms({ path, value }) {
    if (value && typeof value === 'object' && !value.$type) {
        value = $atom(value instanceof Color ?
            value.hsv() : value
        );
    }
    return { path, value };
}
