/* 自动生成，勿手改。运行 npm run gen 重新生成。 */
export interface RawPuzzle {
  id: string
  name: string
  width: number
  height: number
  difficulty: 'easy' | 'medium' | 'hard' | 'custom'
  series: string
  /** 题面编码串（格式由 src/game/puzzles.ts 解析） */
  board: string
  /** 参考解编码串（没有则留空） */
  solution?: string
}

export const EXTRA_PUZZLES: RawPuzzle[] = [
  { id: "killer-4x4-kwhbep", name: "四宫杀手", width: 4, height: 4, difficulty: 'easy', series: "尺寸", board: "1000400000103124|0011001122332233|2110244024563356:3,7,7,4,9,3,7", solution: "1342423124133124" },
  { id: "killer-4x4-kwhbeq", name: "四方笼阵", width: 4, height: 4, difficulty: 'medium', series: "尺寸", board: "0020000000100040|0011001122332233|0055144413331222:4,7,9,8,6,6", solution: "3124423124131342" },
  { id: "killer-6x6-kwhbsx", name: "六宫杀手", width: 6, height: 6, difficulty: 'easy', series: "尺寸", board: "000500000000000000000000001000005002|000111000111222333222333444555444555|1222331655441667780A99980ABCDD0BBCCD:11,10,10,9,3,10,14,3,9,11,6,9,8,13", solution: "214563356421563214142635421356635142" },
  { id: "killer-6x6-kwhbsy", name: "六宫虚线", width: 6, height: 6, difficulty: 'medium', series: "尺寸", board: "000000000300000000030000000000000000|000111000111222333222333444555444555|87776689AA6689BA5099BA50333441222211:4,7,16,10,9,11,17,10,7,18,14,3", solution: "263145145326451263632451514632326514" },
]
