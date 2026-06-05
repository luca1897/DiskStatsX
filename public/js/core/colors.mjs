import { COLORS } from './config.mjs';

const d3 = globalThis.d3;

export function createColorScales() {
  return {
    sunburst: d3.scaleOrdinal(COLORS.sunburst),
    extension: d3.scaleOrdinal(COLORS.extensions)
  };
}
