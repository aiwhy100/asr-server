// 识别结果整理成孩子的问题：去掉开头的语气词和「我想问」之类的引子、合并口吃式重复的疑问词、末尾补问号。
// 只做保守的清理，不改问题本身的意思。
const LEAD_FILLER = /^(?:[嗯呃额啊哦噢唔诶欸哎呀]|那个|就是|然后)[，,。、！!？?\s]*/u;
const LEAD_ASK = /^(?:我想问(?:一下|问)?|我想知道|请问|问一下|问)[，,、\s]*(?=为什么|为啥|怎么|什么|是不是|有没有|哪|谁)/u;
const REPEAT_WH = /(为什么|为啥|怎么样|怎么|是什么)(?:[，,、\s]*\1)+/gu;

/** 去掉开头的语气词 / 引子，合并重复的疑问词 */
export function cleanTranscript(text) {
  let t = String(text ?? '').replace(/\s+/g, '');
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(LEAD_FILLER, '');
  }
  t = t.replace(LEAD_ASK, '');
  return t.replace(REPEAT_WH, '$1');
}

/** 规整成问句：去掉末尾标点，补中文问号；空串原样返回 */
export function toQuestion(text) {
  let q = String(text ?? '').replace(/\s+/g, '').replace(/[。，,.!！~～、]+$/u, '');
  if (!q) return '';
  if (!/[?？]$/.test(q)) q += '？';
  return q.replace(/\?$/, '？');
}
