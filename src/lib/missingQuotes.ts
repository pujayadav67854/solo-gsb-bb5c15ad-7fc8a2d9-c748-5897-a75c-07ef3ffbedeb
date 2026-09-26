// 同引文漏标审阅
//
// 以一条【已绑定】标注为模板，枚举其引文在原文中的全部精确出现位置（含重叠）。
// 判定「已标注」的唯一标准：存在一条【已绑定】标注的起止区间与该出现位置完全相同；
// 待处理标注不算，区间不同（同起点不同终点等）也不算。
// 其余位置即为「漏标」，可勾选后批量补建：复制模板的标签与备注，
// 并为每个位置重新截取锚点上下文（与新建标注同规则）。
//
// 纯函数模块：扫描与补建计划均不修改传入数据。

import type { Annotation } from '../types'
import { findAllOccurrences, makeContext } from './relocation'

/** 漏标列表中前后文摘录的半径（两侧字符数） */
export const EXCERPT_RADIUS = 24

/** 引文的一个精确出现位置 */
export interface QuoteOccurrence {
  start: number
  end: number
  /** 是否已存在起止完全相同的已绑定标注 */
  covered: boolean
}

/** 漏标位置候选（含展示用前后文摘录，被截断的一侧带省略号） */
export interface MissingQuoteCandidate {
  start: number
  end: number
  excerptBefore: string
  excerptAfter: string
}

export interface SameQuoteScan {
  /** 模板标注（已绑定、引文非空） */
  template: Annotation
  quote: string
  /** 全部精确出现位置（含重叠），按起点升序 */
  occurrences: QuoteOccurrence[]
  /** 已被起止完全相同的已绑定标注覆盖的位置数 */
  coveredCount: number
  /** 漏标位置（occurrences 中未覆盖的子集），按起点升序 */
  missing: MissingQuoteCandidate[]
}

/**
 * 扫描模板引文的全部精确出现位置并标出漏标。
 * 模板不存在、非已绑定或引文为空时返回 null（界面按「未选择模板」处理）。
 */
export function scanSameQuote(
  text: string,
  annotations: Annotation[],
  templateId: string,
): SameQuoteScan | null {
  const template = annotations.find((a) => a.id === templateId)
  if (!template || template.status !== 'bound' || !template.quote) return null

  const quote = template.quote
  // 「已标注」判定集合：全部已绑定标注的起止区间（待处理标注不纳入）
  const boundRanges = new Set<string>()
  for (const a of annotations) {
    if (a.status === 'bound') boundRanges.add(`${a.start}:${a.end}`)
  }

  const occurrences: QuoteOccurrence[] = findAllOccurrences(text, quote).map((start) => {
    const end = start + quote.length
    return { start, end, covered: boundRanges.has(`${start}:${end}`) }
  })

  const missing: MissingQuoteCandidate[] = occurrences
    .filter((o) => !o.covered)
    .map((o) => ({
      start: o.start,
      end: o.end,
      excerptBefore:
        (o.start > EXCERPT_RADIUS ? '…' : '') +
        text.slice(Math.max(0, o.start - EXCERPT_RADIUS), o.start),
      excerptAfter:
        text.slice(o.end, Math.min(text.length, o.end + EXCERPT_RADIUS)) +
        (text.length - o.end > EXCERPT_RADIUS ? '…' : ''),
    }))

  return {
    template,
    quote,
    occurrences,
    coveredCount: occurrences.length - missing.length,
    missing,
  }
}

export interface MissingQuoteFillPlan {
  templateId: string
  quote: string
  /** 实际补建的位置起点（升序） */
  createdStarts: number[]
  /** 选中但因已变化 / 已补过而跳过的位置起点（升序） */
  skippedStarts: number[]
  /** 新建标注（顺序与 createdStarts 一致，由调用方追加到标注集） */
  created: Annotation[]
}

/** 默认标注 ID 生成器（与 App 同规则）；测试可注入确定性工厂 */
export function makeMissingQuoteAnnotationId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 计算批量补建计划：以【传入的最新】原文与标注集重新核对——
 * 仅仍为漏标的位置会被补建；已变化（该位置不再是引文的精确出现处）
 * 或已补过（已存在起止完全相同的已绑定标注）的位置记入 skippedStarts。
 * 新标注复制模板的标签与备注，并为各位置重新截取锚点上下文。
 * 纯函数：不修改传入数据。模板失效（删除 / 待处理 / 空引文）时返回 null。
 */
export function planMissingQuoteFill(
  text: string,
  annotations: Annotation[],
  templateId: string,
  selectedStarts: Iterable<number>,
  now: number = Date.now(),
  makeId: () => string = makeMissingQuoteAnnotationId,
): MissingQuoteFillPlan | null {
  const scan = scanSameQuote(text, annotations, templateId)
  if (!scan) return null
  const template = scan.template

  const missingByStart = new Map(scan.missing.map((m) => [m.start, m]))
  const wanted = [...new Set(selectedStarts)].sort((a, b) => a - b)

  const createdStarts: number[] = []
  const skippedStarts: number[] = []
  const created: Annotation[] = []

  for (const start of wanted) {
    const hit = missingByStart.get(start)
    if (!hit) {
      skippedStarts.push(start)
      continue
    }
    const ctx = makeContext(text, hit.start, hit.end)
    created.push({
      id: makeId(),
      quote: text.slice(hit.start, hit.end),
      start: hit.start,
      end: hit.end,
      note: template.note,
      tags: [...template.tags],
      status: 'bound',
      createdAt: now,
      updatedAt: now,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
    })
    createdStarts.push(start)
  }

  return { templateId, quote: scan.quote, createdStarts, skippedStarts, created }
}
