/**
 * 杀手数独题库生成配置
 */

import { generateExtraPuzzles as generateExtra } from '../src/game/generator.ts'

export const NAME = '杀手数独生成器'

/** 多尺寸内置题（4/6/12/16 等），写入 puzzles-extra-data.ts；旧 9×9 保留在 puzzles-data.ts */
export function generateExtraPuzzles() {
  return generateExtra()
}
