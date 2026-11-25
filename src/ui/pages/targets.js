import { esc, icon, targetTypeLabel } from '../dom.js';

export function renderTargets(state) {
  const active = state.targets.find((t) => t.id === state.targetId) || state.targets[0];
  return `
  <div class="page-head">
    <div>
      <h1 class="page-title">目标注册中心</h1>
      <p class="page-desc">靶子位于仓库的 <code>targets/</code> 目录。每个靶子声明二进制语法、覆盖率边和插桩点；解析器通过 <code>TargetContext</code> 上报边、语法节点和越界访问。</p>
    </div>
    <div class="head-actions">
      <button class="btn" data-action="view-registration">${icon('target')}注册方式</button>
      <button class="btn primary" data-action="navigate" data-route="monitor">${icon('play')}开始 Fuzz</button>
    </div>
  </div>

  <div class="target-grid mb-4">
    ${state.targets.map((target) => `
      <article class="card target-card ${target.id === active.id ? 'active' : ''}" data-action="select-target" data-id="${esc(target.id)}">
        <div class="target-kind">
          <div class="target-icon">${esc((target.magic || target.id).slice(0, 2))}</div>
          <span class="badge cyan">${targetTypeLabel(target.kind)}</span>
        </div>
        <h3>${esc(target.name)}</h3>
        <p>${esc(target.description)}</p>
        <div class="target-meta">
          <span class="badge">${target.grammar.rules.length} 条语法规则</span>
          <span class="badge">${target.edges.length} 条边</span>
          <span class="badge">${target.instrumentation.length} 个插桩点</span>
          <span class="badge accent">${target.seeds.length} 个种子</span>
        </div>
      </article>`).join('')}
  </div>

  <div class="grid cols-2">
    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">输入语法声明 · ${esc(active.name)}</h2>
          <div class="card-sub mono">${esc(active.file)} · ${esc(active.grammar.byteOrder || 'unspecified endian')}</div>
        </div>
        <button class="btn small ghost" data-action="view-source" data-id="${esc(active.id)}">查看源码</button>
      </div>
      <div class="card-body grammar">
        ${active.grammar.rules.map(renderRule).join('')}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">插桩点与漏洞访问点</h2>
          <div class="card-sub">红色为已知缺失边界校验的 OOB 站点；指纹只取稳定调用栈，不含攻击者控制的 offset。</div>
        </div>
      </div>
      <div class="card-body">
        <div class="instrument-list">
          ${active.instrumentation.map((point) => `
            <div class="instrument-item ${point.kind === 'oob-site' ? 'oob-site' : ''}">
              <i class="pin"></i>
              <div>
                <div class="instrument-label">${esc(point.label)}</div>
                <div class="instrument-id">${esc(point.id)}</div>
              </div>
              <span class="badge ${point.kind === 'oob-site' ? 'high' : point.kind === 'branch' ? 'cyan' : ''}">${esc(point.kind)}</span>
            </div>`).join('')}
        </div>

        <h3 class="section-title">覆盖率边</h3>
        <div class="table-wrap" style="max-height:280px;border:1px solid var(--border);border-radius:10px">
          <table class="data">
            <thead><tr><th>Edge ID</th><th>转换</th><th>说明</th></tr></thead>
            <tbody>
              ${active.edges.map((edge) => `
                <tr style="cursor:default">
                  <td class="mono-cell">${esc(edge.id)}</td>
                  <td class="mono dim">${esc(edge.from)} → ${esc(edge.to)}</td>
                  <td>${esc(edge.label)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>`;
}

function renderRule(rule) {
  if (rule.kind === 'choice') {
    return `
      <div class="grammar-rule">
        <div class="grammar-rule-head"><span>${esc(rule.id)}</span><span>choice · low2 op</span></div>
        <div class="grammar-fields">
          ${(rule.choices || []).map((choice) => `
            <div class="grammar-field">
              <span class="fname">op=${choice.op} ${esc(choice.name)}</span>
              <span class="ftype">choice</span>
              <span>${(choice.fields || []).map((f) => esc(f.name)).join(', ')}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }
  return `
    <div class="grammar-rule">
      <div class="grammar-rule-head"><span>${esc(rule.id)}</span><span>${esc(rule.kind || 'struct')}</span></div>
      <div class="grammar-fields">
        ${(rule.fields || []).map((field) => `
          <div class="grammar-field">
            <span class="fname">${esc(field.name)}</span>
            <span class="ftype">${esc(field.type)}</span>
            <span class="dim">${field.enum ? `enum ${esc(JSON.stringify(field.enum))}` : field.lengthFrom ? `lengthFrom=${esc(field.lengthFrom)}` : field.value !== undefined ? `value=${esc(field.value)}` : field.node ? `node=${esc(field.node)}` : ''}</span>
          </div>`).join('')}
      </div>
    </div>`;
}
