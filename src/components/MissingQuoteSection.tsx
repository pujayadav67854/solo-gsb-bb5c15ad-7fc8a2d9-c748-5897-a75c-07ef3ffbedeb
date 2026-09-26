import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation } from '../types'
import { scanSameQuote } from '../lib/missingQuotes'

interface Props {
  text: string
  annotations: Annotation[]
  /**
   * 提交批量补建：App 以最新文档重新核对候选位置与现有标注后落地，
   * 返回实际补建 / 跳过数（已变化或已补过的位置被跳过）。
   */
  onFill: (templateId: string, starts: number[]) => { created: number; skipped: number }
  /** 点击漏标 / 已标注位置：在原文中滚动定位 */
  onLocateOffset: (offset: number) => void
  /** 分区滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

interface ResultMessage {
  kind: 'ok' | 'info'
  text: string
}

/** 模板下拉选项文案：区间 + 引文摘录 + 标签，长引文截断 */
function templateOptionLabel(a: Annotation): string {
  const quote = (a.quote || '（空引文）').replace(/\s+/g, ' ')
  const shown = quote.length > 24 ? `${quote.slice(0, 24)}…` : quote
  const tags = a.tags.length > 0 ? ` #${a.tags.join(' #')}` : ''
  return `[${a.start},${a.end}) ${shown}${tags}`
}

/**
 * 同引文漏标审阅侧栏分区：
 * 选一条已绑定标注作模板 → 枚举其引文的全部精确出现位置（含重叠）→
 * 仅起止完全相同的已绑定标注算已标注 → 勾选漏标位置批量补建
 * （复制模板标签与备注，各位置重新截取锚点上下文）。
 * 扫描结果纯派生：原文 / 标注编辑、导入后随依赖自动重算。
 */
export function MissingQuoteSection({ text, annotations, onFill, onLocateOffset, sectionRef }: Props) {
  const [templateId, setTemplateId] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const [message, setMessage] = useState<ResultMessage | null>(null)

  // 结果提示自动消失
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 8000)
    return () => clearTimeout(t)
  }, [message])

  // 模板候选：全部已绑定且引文非空的标注，按原文位置排列
  const boundAnnotations = useMemo(
    () =>
      annotations
        .filter((a) => a.status === 'bound' && a.quote.length > 0)
        .sort(
          (x, y) =>
            x.start - y.start || x.end - y.end || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
        ),
    [annotations],
  )

  // 模板被删除或进入待处理 → 视为未选择（扫描结果随之清空，实时更新）
  const effectiveTemplateId = boundAnnotations.some((a) => a.id === templateId)
    ? templateId
    : ''

  const scan = useMemo(
    () => (effectiveTemplateId ? scanSameQuote(text, annotations, effectiveTemplateId) : null),
    [text, annotations, effectiveTemplateId],
  )

  const missingStarts = useMemo(
    () => new Set((scan?.missing ?? []).map((m) => m.start)),
    [scan],
  )
  // 勾选集随最新扫描收敛：已补过 / 已变化的位置自动失效
  const effectiveSelected = useMemo(
    () => selected.filter((s) => missingStarts.has(s)),
    [selected, missingStarts],
  )
  const effectiveSet = useMemo(() => new Set(effectiveSelected), [effectiveSelected])

  const allMissingSelected =
    !!scan && scan.missing.length > 0 && effectiveSelected.length === scan.missing.length

  const changeTemplate = (id: string) => {
    setTemplateId(id)
    setSelected([])
    setMessage(null)
  }

  const toggleOne = (start: number) => {
    setSelected((prev) =>
      prev.includes(start) ? prev.filter((s) => s !== start) : [...prev, start],
    )
  }

  const toggleAll = () => {
    if (!scan) return
    setSelected(allMissingSelected ? [] : scan.missing.map((m) => m.start))
  }

  const confirmFill = () => {
    if (!scan || effectiveSelected.length === 0) return
    const { created, skipped } = onFill(scan.template.id, effectiveSelected)
    setSelected([])
    setMessage({
      kind: created > 0 ? 'ok' : 'info',
      text:
        created > 0
          ? skipped > 0
            ? `已补建 ${created} 条标注（复制模板标签与备注）；${skipped} 个位置已变化或已补过，已跳过。`
            : `已补建 ${created} 条标注（复制模板标签与备注）。`
          : '所选位置已变化或已补过，没有可补建的位置，数据未改动。',
    })
  }

  const coveredOccurrences = scan?.occurrences.filter((o) => o.covered) ?? []

  return (
    <section
      className="side-section missing-quote-section"
      ref={(sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2
        className={`side-heading ${scan && scan.missing.length > 0 ? 'side-heading-missing' : ''}`}
      >
        同引文漏标审阅
        {scan && scan.missing.length > 0 && (
          <span className="conflict-count-badge missing-count-badge" title="漏标位置数">
            {scan.missing.length}
          </span>
        )}
      </h2>
      <p className="side-hint">
        选一条<strong>已绑定标注</strong>作为模板，枚举其引文在原文中的
        <strong>全部精确出现位置（含重叠）</strong>：只有<strong>起止完全相同</strong>的
        已绑定标注算已标注（待处理不算），其余位置列为<strong>漏标</strong>。
        勾选漏标位置后可<strong>批量补建标注</strong>——复制模板的标签与备注，
        并为各位置重新截取锚点上下文。
      </p>

      {boundAnnotations.length === 0 ? (
        <p className="side-hint">还没有已绑定标注。先在原文中拖选添加标注后，再来审阅漏标。</p>
      ) : (
        <>
          <select
            className="rule-input mq-select"
            value={effectiveTemplateId}
            onChange={(e) => changeTemplate(e.target.value)}
            aria-label="选择模板标注"
          >
            <option value="">选择模板标注…</option>
            {boundAnnotations.map((a) => (
              <option key={a.id} value={a.id}>
                {templateOptionLabel(a)}
              </option>
            ))}
          </select>

          {scan && (
            <>
              <div className="mq-summary">
                <span className="mq-summary-item">
                  共出现 <strong>{scan.occurrences.length}</strong> 处
                </span>
                <span className="mq-summary-item">
                  已标注 <strong>{scan.coveredCount}</strong>
                </span>
                <span
                  className={`mq-summary-item ${scan.missing.length > 0 ? 'mq-summary-missing' : ''}`}
                >
                  漏标 <strong>{scan.missing.length}</strong>
                </span>
              </div>

              {message && (
                <p className={`bulk-message bulk-message-${message.kind}`}>{message.text}</p>
              )}

              {scan.missing.length === 0 ? (
                <p className="cov-ok">✓ 全部出现位置均已有起止完全相同的已绑定标注，没有漏标。</p>
              ) : (
                <>
                  <div className="bulk-match-bar">
                    <span className="bulk-match-count">
                      漏标 <strong>{scan.missing.length}</strong> 处
                      {effectiveSelected.length > 0 && <em> · 已选 {effectiveSelected.length} 处</em>}
                    </span>
                    <span className="bulk-match-actions">
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        onClick={toggleAll}
                      >
                        {allMissingSelected ? '取消全选' : '全选'}
                      </button>
                    </span>
                  </div>

                  <ul className="mq-list">
                    {scan.missing.map((m) => {
                      const checked = effectiveSet.has(m.start)
                      return (
                        <li
                          key={m.start}
                          className={`mq-item ${checked ? 'mq-item-on' : ''}`}
                        >
                          <label className="bulk-check">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleOne(m.start)}
                              aria-label={checked ? '取消选择该漏标位置' : '选择该漏标位置'}
                            />
                          </label>
                          <button
                            type="button"
                            className="mq-item-main"
                            title="在原文中定位该位置"
                            onClick={() => onLocateOffset(m.start)}
                          >
                            <span className="mq-pos">
                              [{m.start},{m.end})
                            </span>
                            <span className="mq-excerpt">
                              {m.excerptBefore && (
                                <span className="mq-ctx">{m.excerptBefore}</span>
                              )}
                              <span className="mq-quote-mark">{scan.quote}</span>
                              {m.excerptAfter && (
                                <span className="mq-ctx">{m.excerptAfter}</span>
                              )}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>

                  <div className="bulk-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={effectiveSelected.length === 0}
                      onClick={confirmFill}
                      title="为勾选的漏标位置补建标注：复制模板标签与备注，并重新截取锚点上下文"
                    >
                      批量补建标注
                      {effectiveSelected.length > 0 ? `（${effectiveSelected.length}）` : ''}
                    </button>
                    {effectiveSelected.length === 0 && (
                      <span className="side-hint bulk-action-hint">
                        勾选漏标位置后即可批量补建。
                      </span>
                    )}
                  </div>
                </>
              )}

              {coveredOccurrences.length > 0 && (
                <details className="mq-covered-fold">
                  <summary>已标注位置（{coveredOccurrences.length}）</summary>
                  <ul className="mq-covered-list">
                    {coveredOccurrences.map((o) => (
                      <li key={o.start}>
                        <button
                          type="button"
                          className="mq-covered-pos"
                          title="在原文中定位该位置"
                          onClick={() => onLocateOffset(o.start)}
                        >
                          [{o.start},{o.end})
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
