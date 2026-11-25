# FuzzBench · 浏览器 Fuzz 工作台

一个零外部依赖、可离线运行的浏览器 Fuzz 工作台。变异和调度运行在 ES Module Web Worker 中，语料、崩溃样本和 checkpoint 持久化到 IndexedDB。仓库内置三个带显式插桩的靶子：

- `targets/tlv.js` — `TLV1` 二进制 TLV 协议
- `targets/image-header.js` — `IMG1` 图片头 / chunk 表
- `targets/puff.js` — `LZPK` 自定义压缩命令流

三个靶子中包含手工 fuzz 常见的越界读根因：未校验的尾部 CRC、偏移表解引用、末像素 stride 计算、chunk guard、负 match distance、静态字典索引等。所有越界访问都通过插桩内存原语捕获，因此可以稳定生成栈指纹并最小化。

## 快速开始

```bash
npm start
# 打开 http://127.0.0.1:5173
```

也可以使用任意静态服务器，但必须通过 `http://` 或 `https://` 提供，不要直接双击 `index.html`（ES Module Worker 在 `file://` 下会被浏览器阻止）。

运行核心确定性测试：

```bash
npm test
```

本地命令行观察三个靶子的崩溃和最小化样本：

```bash
node scripts/inspect.mjs 3000
```

## 页面

- **目标**：注册靶子、查看输入语法、插桩点、覆盖率边和源码。
- **语料库**：内置种子、自动入队的新边样本、原始文件/JSON 导入导出、Hex 预览、删除和下载。
- **运行监控**：开始/暂停/继续、exec/s、唯一边数曲线、崩溃数、资源限制、RNG checkpoint、高权重种子和实时事件。
- **崩溃详情**：按栈指纹去重、稳定调用栈、访问详情、原始 Hex、一键最小化、最小样本回放验证和下载。
- **设置**：确定性 seed、batch、超时、内存、操作预算、变异器权重、调度系数、确定性自检和整个工作区导入导出。

## 确定性保证

相同的：

1. 靶子代码，
2. 设置（seed、变异权重、限制），
3. 初始语料库，
4. checkpoint/RNG 状态，

会产生相同的崩溃指纹集合和命中次数。

实现约束：

- 所有变异和调度随机数都经过 `src/core/rng.js` 的可 checkpoint mulberry32 PRNG。
- 禁止在变异/调度路径使用 `Math.random()`。
- `Date.now()` / `performance.now()` 只用于展示时间、exec/s 和超时保护，不参与选种或变异决策。
- 每个 batch 结束后保存 RNG state、iteration、边计数、曲线和语料调度元数据。
- Worker 会等待主线程把 checkpoint 写入 IndexedDB 并 ACK，再消费后续随机数，因此刷新后可从最近 batch 精确续跑。
- `tests/determinism.test.js` 对同一 seed 运行两个独立引擎并比较指纹集合、计数和 RNG 终态。
- `tests/checkpoint.test.js` 验证“跑到一半 → 序列化 checkpoint → 新引擎恢复 → 继续”的结果与一次跑完一致。

> 注意：墙钟超时在极慢机器上理论上可能产生额外 timeout 资源事件。核心解析器都有高频插桩检查点，默认 250ms 很宽松；同时还有与机器速度无关的确定性 op budget。普通 OOB 崩溃集合不受时间影响。

## 变异与覆盖

四种必需变异均在 `src/core/mutators.js`：

- `bitflip`：1/2/4 比特翻转
- `integer-boundary`：优先改写 grammar span 中的 u8/u16/u32 字段为 `0,1,0x7f,0x80,0xff,0x7fff,0x8000,0xffffffff` 等边界值
- `block-splice`：当前样本和语料 donor 之间替换、拼接、插入块
- `grammar-structure`：基于运行时记录的 `nodes` / `spans` 删除或复制完整 Record、image chunk、LZ 命令，并语义化改写数字/enum 字段

调度器对发现新边的父样本累加 `novelty`，权重为：

```text
(1 + novelty * noveltyWeight + sqrt(edgeCount) * edgeWeight)
/ sqrt(1 + selectedCount * useCountPenalty)
```

覆盖率按显式 edge ID 计数，全局 `edgeCounts: Map<edgeId, count>`；第一次出现的 edge 让输入成为 interesting corpus，并给父样本加权。

## 崩溃指纹与最小化

`src/core/fingerprint.js` 使用：

```text
targetId + fault kind + 靶子声明的稳定调用栈帧
```

生成 `fp_...`。attacker-controlled offset、样本字节、行内数值和命中次数不进入指纹。零/负 match distance 这类位于同一 `decodeMatch` 根因的问题会合并为一条。

最小化器 `src/core/minimizer.js` 是确定性的：

1. 先验证原样本和目标指纹；
2. ddmin 风格块删除；
3. length-aware 协同改写/截断（先把 length 改小，再删除原本被 length 引用的尾部）；
4. 逐字节替换为简单值；
5. 再跑删除轮；
6. 最终重新执行并要求 fingerprint 完全一致。

UI 中最小化完成后会自动保存 `reproduced: true` 和最终验证结果；详情页“重新验证”会优先回放最小样本。

## 单次执行限制

`TargetContext`（`targets/harness.js`）提供：

- `timeoutMs`：在插桩 tick / Reader 访问中检查 deadline；
- `maxOps`：与机器速度无关的确定性操作预算，防止无界循环；
- `maxMemoryBytes`：通过 `ctx.allocBytes(size, label)` 的计量分配器在真正 `new Uint8Array(size)` 前拦截超大分配。

靶子中较大的输出/行缓冲都通过 `ctx.allocBytes` 分配。添加新靶子时，不要直接让攻击者控制的长度进入大型分配；先调用 `ctx.allocBytes`。

## 持久化

IndexedDB 数据库：`fuzz-workbench-db`，object store：`kv`。

键包括：

```text
fuzz:settings:v1
fuzz:active-target:v1
fuzz:corpus:<targetId>:v1
fuzz:crashes:<targetId>:v1
fuzz:checkpoint:<targetId>:v1
```

原始 `Uint8Array` 样本直接通过结构化克隆存储。导出 JSON 时才转换为 base64。

## 注册新靶子

在 `targets/` 新建文件并加入 `targets/index.js`：

```js
export const myTarget = {
  id: 'my-format',
  name: 'My Format',
  kind: 'protocol',
  file: 'targets/my-format.js',
  grammar: {
    root: 'Message',
    rules: [
      {
        id: 'Message',
        kind: 'seq',
        fields: [
          { name: 'magic', type: 'const', size: 4, value: 'MYF1' },
          { name: 'length', type: 'u16' },
          { name: 'body', type: 'bytes', lengthFrom: 'length' },
        ],
      },
    ],
  },
  instrumentation: [
    { id: 'my.oob-site', label: '未校验偏移解引用', kind: 'oob-site' },
  ],
  edges: [
    { id: 'my.start', from: 'entry', to: 'parse', label: '开始' },
    { id: 'my.oob-site', from: 'offset', to: 'deref', label: '越界点' },
  ],
  seeds: [
    { name: 'valid.bin', bytes: new Uint8Array([0x4d, 0x59, 0x46, 0x31]) },
  ],
  parse(input, ctx) {
    ctx.edge('my.start');
    // 使用 targets/harness.js 的 Reader。
    // 缺失边界检查时调用 ctx.fault('oob-read', message, { frames, access })。
  },
};
```

然后在 `targets/index.js` 中 `import` 并 `registerTarget(myTarget)`。也可以在 DevTools 中调用：

```js
globalThis.FuzzWorkbench.registerTarget(myTarget);
```

## 目录

```text
index.html
server.js                  # 零依赖静态服务器
src/core/                  # RNG、引擎、变异、覆盖、指纹、最小化
src/data/storage.js        # IndexedDB KV
src/state/                 # 设置持久化
src/worker/fuzz.worker.js  # Web Worker 协议与 batch 循环
src/ui/pages/              # 五个页面
targets/                   # 三个靶子与共享插桩 harness
tests/                     # Node 确定性 / checkpoint / 最小化测试
scripts/inspect.mjs        # CLI 检查脚本
```

## 浏览器建议

推荐使用 Chromium / Chrome / Edge 最新版。Firefox/Safari 也支持 ES Module Worker 和 IndexedDB，但非标准的 `performance.memory` 没有被依赖；内存限制始终来自靶子使用的计量分配器。
