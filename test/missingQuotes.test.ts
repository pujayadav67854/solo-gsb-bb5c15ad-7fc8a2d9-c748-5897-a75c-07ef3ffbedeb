import assert from 'node:assert'
import {
  EXCERPT_RADIUS,
  planMissingQuoteFill,
  scanSameQuote,
} from '../src/lib/missingQuotes'
import { CONTEXT_RADIUS } from '../src/lib/relocation'
import type { Annotation } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  id: string,
  start: number,
  end: number,
  tags: string[] = [],
  opts: Partial<Annotation> = {},
): Annotation {
  seq += 1
  return {
    id,
    quote: opts.quote ?? '',
    start,
    end,
    note: opts.note ?? '',
    tags,
    status: opts.status ?? 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
    ...opts,
  }
}

// 确定性 ID 工厂
function idFactory() {
  let n = 0
  return () => `new_${++n}`
}

// 1. 枚举全部精确出现位置（含重叠）
check('扫描：枚举全部精确出现位置（含重叠）', () => {
  const text = 'aaaa'
  const t = ann('t', 0, 2, [], { quote: 'aa' })
  const scan = scanSameQuote(text, [t], 't')!
  assert.ok(scan)
  assert.deepStrictEqual(
    scan.occurrences.map((o) => [o.start, o.end]),
    [
      [0, 2],
      [1, 3],
      [2, 4],
    ],
  )
  // 模板自身覆盖 [0,2)，其余两处漏标
  assert.strictEqual(scan.coveredCount, 1)
  assert.deepStrictEqual(
    scan.missing.map((m) => m.start),
    [1, 2],
  )
})

// 2. 只有起止完全相同的已绑定标注算已标注
check('已标注判定：仅起止完全相同的已绑定标注', () => {
  const text = '甲乙甲乙甲乙'
  const t = ann('t', 0, 2, [], { quote: '甲乙' })
  const anns = [
    t,
    ann('same', 2, 4), // 起止完全相同 → 覆盖 [2,4)
    ann('diff-end', 4, 6), // 与出现位置 [4,6) 相同 → 覆盖
  ]
  const scan = scanSameQuote(text, anns, 't')!
  assert.strictEqual(scan.occurrences.length, 3)
  assert.strictEqual(scan.coveredCount, 3)
  assert.strictEqual(scan.missing.length, 0)

  // 区间不同（同起点不同终点 / 包含关系）不算已标注
  const anns2 = [t, ann('wide', 2, 5), ann('shift', 3, 5)]
  const scan2 = scanSameQuote(text, anns2, 't')!
  assert.strictEqual(scan2.coveredCount, 1, '只有模板自身位置算已标注')
  assert.deepStrictEqual(
    scan2.missing.map((m) => m.start),
    [2, 4],
  )
})

// 3. 待处理标注不算已标注
check('待处理标注不算已标注', () => {
  const text = '甲乙甲乙'
  const t = ann('t', 0, 2, [], { quote: '甲乙' })
  const pending = ann('p', 2, 4, [], {
    status: 'pending',
    pendingReason: '原文中已找不到该引文，需要手动重新选择',
  })
  const scan = scanSameQuote(text, [t, pending], 't')!
  assert.strictEqual(scan.coveredCount, 1)
  assert.deepStrictEqual(
    scan.missing.map((m) => m.start),
    [2],
  )
})

// 4. 模板失效：不存在 / 待处理 / 空引文 → null
check('模板不存在、待处理或空引文时返回 null', () => {
  const text = '甲乙丙丁'
  const bound = ann('b', 0, 2, [], { quote: '甲乙' })
  const pending = ann('p', 0, 2, [], { status: 'pending', quote: '甲乙' })
  const empty = ann('e', 0, 0, [], { quote: '' })
  assert.strictEqual(scanSameQuote(text, [bound], 'ghost'), null)
  assert.strictEqual(scanSameQuote(text, [pending], 'p'), null)
  assert.strictEqual(scanSameQuote(text, [empty], 'e'), null)
})

// 5. 前后文摘录：半径截取，截断侧带省略号
check('漏标候选带前后文摘录，截断侧带省略号', () => {
  const head = '前'.repeat(EXCERPT_RADIUS + 5)
  const tail = '后'.repeat(EXCERPT_RADIUS + 5)
  const text = `${head}目标${tail}`
  const start = head.length
  const t = ann('t', 0, 2, [], { quote: '目标' }) // 模板本身不在文中出现，仅作引文来源
  const scan = scanSameQuote(text, [t], 't')!
  assert.strictEqual(scan.missing.length, 1)
  const m = scan.missing[0]
  assert.strictEqual(m.start, start)
  assert.strictEqual(m.end, start + 2)
  assert.ok(m.excerptBefore.startsWith('…'), '前文截断应带省略号')
  assert.strictEqual(m.excerptBefore.length, EXCERPT_RADIUS + 1)
  assert.ok(m.excerptAfter.endsWith('…'), '后文截断应带省略号')
  assert.strictEqual(m.excerptAfter.length, EXCERPT_RADIUS + 1)

  // 边界处不截断、不带省略号
  const scan2 = scanSameQuote('目标甲乙', [ann('t2', 5, 7, [], { quote: '目标' })], 't2')!
  assert.strictEqual(scan2.missing[0].excerptBefore, '')
  assert.strictEqual(scan2.missing[0].excerptAfter, '甲乙')
})

// 6. 补建：复制模板标签与备注，重新截取锚点上下文
check('补建：复制模板标签与备注，各位置重新截取锚点上下文', () => {
  const text = '开头甲乙中间甲乙结尾甲乙收束'
  const t = ann('t', 2, 4, ['重点', '正面'], {
    quote: '甲乙',
    note: '模板备注',
    contextBefore: '旧前',
    contextAfter: '旧后',
  })
  const plan = planMissingQuoteFill(text, [t], 't', [6, 10], 1000, idFactory())!
  assert.ok(plan)
  assert.deepStrictEqual(plan.createdStarts, [6, 10])
  assert.deepStrictEqual(plan.skippedStarts, [])
  assert.strictEqual(plan.created.length, 2)

  const [c1, c2] = plan.created
  assert.strictEqual(c1.id, 'new_1')
  assert.strictEqual(c1.quote, '甲乙')
  assert.strictEqual(c1.start, 6)
  assert.strictEqual(c1.end, 8)
  assert.deepStrictEqual(c1.tags, ['重点', '正面'])
  assert.strictEqual(c1.note, '模板备注')
  assert.strictEqual(c1.status, 'bound')
  assert.strictEqual(c1.createdAt, 1000)
  assert.strictEqual(c1.updatedAt, 1000)
  // 上下文按新位置重新截取（CONTEXT_RADIUS 内）
  assert.strictEqual(c1.contextBefore, text.slice(Math.max(0, 6 - CONTEXT_RADIUS), 6))
  assert.strictEqual(c1.contextAfter, text.slice(8, Math.min(text.length, 8 + CONTEXT_RADIUS)))
  assert.notStrictEqual(c1.contextBefore, '旧前')
  assert.strictEqual(c2.id, 'new_2')
  assert.strictEqual(c2.start, 10)
  // 标签是副本而非共享引用
  assert.notStrictEqual(c1.tags, t.tags)
})

// 7. 提交时重核：已补过 / 已变化的位置跳过
check('提交时重核：已补过或已变化的位置跳过', () => {
  const text = '甲乙甲乙甲乙'
  const t = ann('t', 0, 2, ['X'], { quote: '甲乙' })
  // 位置 2 已被另一条起止完全相同的已绑定标注补过
  const filled = ann('f', 2, 4, [], { quote: '甲乙' })
  const plan = planMissingQuoteFill(text, [t, filled], 't', [2, 4], 1000, idFactory())!
  assert.deepStrictEqual(plan.createdStarts, [4])
  assert.deepStrictEqual(plan.skippedStarts, [2])
  assert.strictEqual(plan.created.length, 1)
  assert.strictEqual(plan.created[0].start, 4)

  // 文本变化后位置 4 不再是引文出现处 → 跳过
  const changed = '甲乙甲乙丙丁'
  const plan2 = planMissingQuoteFill(changed, [t], 't', [4], 1000, idFactory())!
  assert.deepStrictEqual(plan2.createdStarts, [])
  assert.deepStrictEqual(plan2.skippedStarts, [4])
  assert.strictEqual(plan2.created.length, 0)
})

// 8. 重叠出现位置可分别补建
check('重叠出现位置可分别补建', () => {
  const text = 'aaaa'
  const t = ann('t', 0, 2, [], { quote: 'aa' })
  const plan = planMissingQuoteFill(text, [t], 't', [1, 2], 1000, idFactory())!
  assert.deepStrictEqual(plan.createdStarts, [1, 2])
  assert.strictEqual(plan.created.length, 2)
  assert.deepStrictEqual(
    plan.created.map((a) => [a.start, a.end]),
    [
      [1, 3],
      [2, 4],
    ],
  )
})

// 9. 模板失效 → null；空选择 → 空计划
check('模板失效返回 null；空选择返回空计划', () => {
  const text = '甲乙甲乙'
  const t = ann('t', 0, 2, [], { quote: '甲乙' })
  assert.strictEqual(planMissingQuoteFill(text, [t], 'ghost', [2]), null)
  const pending = ann('p', 0, 2, [], { status: 'pending', quote: '甲乙' })
  assert.strictEqual(planMissingQuoteFill(text, [pending], 'p', [2]), null)

  const plan = planMissingQuoteFill(text, [t], 't', [], 1000, idFactory())!
  assert.ok(plan)
  assert.strictEqual(plan.created.length, 0)
  assert.deepStrictEqual(plan.skippedStarts, [])
})

// 10. 选中位置去重并升序；不修改输入数据
check('选中位置去重升序；输入数据不被修改', () => {
  const text = '甲乙甲乙甲乙'
  const t = ann('t', 0, 2, ['甲'], { quote: '甲乙' })
  const before = JSON.stringify(t)
  const plan = planMissingQuoteFill(text, [t], 't', [4, 2, 4, 2], 1000, idFactory())!
  assert.deepStrictEqual(plan.createdStarts, [2, 4])
  assert.strictEqual(JSON.stringify(t), before, '模板标注不被修改')
  assert.strictEqual(t.tags.length, 1)
})

// 11. 端到端：扫描 → 补建 → 再扫描无漏标
check('端到端：补建结果并入标注集后再扫描无漏标', () => {
  const text = '甲乙和甲乙和甲乙'
  const t = ann('t', 0, 2, ['重点'], { quote: '甲乙', note: 'n' })
  const scan1 = scanSameQuote(text, [t], 't')!
  assert.strictEqual(scan1.missing.length, 2)
  const plan = planMissingQuoteFill(
    text,
    [t],
    't',
    scan1.missing.map((m) => m.start),
    1000,
    idFactory(),
  )!
  const next = [t, ...plan.created]
  const scan2 = scanSameQuote(text, next, 't')!
  assert.strictEqual(scan2.missing.length, 0)
  assert.strictEqual(scan2.coveredCount, 3)
  // 新标注自身也可作为模板
  const scan3 = scanSameQuote(text, next, plan.created[0].id)!
  assert.strictEqual(scan3.missing.length, 0)
})

console.log(`\nmissingQuotes：${passed} 项断言全部通过`)
