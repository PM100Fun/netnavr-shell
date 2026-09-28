import { useEffect, useRef, useState } from "react";
import type { FixtureCommandInput, FixtureCommandResult } from "@netnavr/core/fixture-contract";
import type { FixtureBridgeResult, FixtureReadout } from "../../desktop/src/fixture-bridge.js";
import { DESIGN_FLOWS } from "./designFlows";

export function EngineeringApp() {
  const [page, setPage] = useState("engineering");
  const [readout, setReadout] = useState<FixtureReadout>({ state: "stopped" });
  const [result, setResult] = useState<FixtureCommandResult | null>(null);
  const [lastInput, setLastInput] = useState<FixtureCommandInput | null>(null);
  const [marker, setMarker] = useState<"alpha" | "beta">("alpha");
  const [delayMs, setDelayMs] = useState(500);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const commandTerminal = useRef(false);
  const activeCommandId = useRef<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const bridge = window.netnavr;
  const pending = result?.status === "pending";
  const online = readout.state === "online";
  useEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [page]);

  function accept<T>(response: FixtureBridgeResult<T>): T | null {
    if (!response.ok) { setError(`${response.error.code}：${response.error.message}`); return null; }
    setError(null);
    return response.value;
  }
  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await work(); } catch { setError("桌面桥请求失败。请查看候选的技术验证记录并显式重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function refresh() {
    if (!bridge) return;
    const requestGeneration = generation.current;
    const response = await bridge.getFixture();
    if (requestGeneration !== generation.current) return;
    const value = accept(response);
    setReadout(value ?? { state: "error" });
  }
  async function start() {
    if (!bridge) return;
    const requestGeneration = ++generation.current;
    commandTerminal.current = false;
    activeCommandId.current = null;
    setResult(null); setLastInput(null);
    const response = await bridge.startFixture();
    if (requestGeneration !== generation.current) return;
    const value = accept(response);
    setReadout(value ?? { state: "error" });
  }
  async function stop() {
    if (!bridge) return;
    const requestGeneration = ++generation.current;
    commandTerminal.current = true;
    activeCommandId.current = null;
    const response = await bridge.stopFixture();
    if (requestGeneration !== generation.current) return;
    const value = accept(response);
    if (value) { setReadout(value); setResult(null); setLastInput(null); }
    else setReadout({ state: "error" });
  }
  async function submit(input: FixtureCommandInput) {
    if (!bridge) return;
    const requestGeneration = generation.current;
    activeCommandId.current = input.commandId;
    const response = await bridge.submitFixture(input);
    if (requestGeneration !== generation.current || activeCommandId.current !== input.commandId) return;
    const value = accept(response);
    if (value) commandTerminal.current = value.status !== "pending";
    if (value) { setLastInput(input); setResult(value); setReadout({ state: "online", fixture: value.state }); }
  }
  async function cancel() {
    if (!bridge || !result) return;
    const requestGeneration = generation.current;
    const response = await bridge.cancelFixture(result.commandId);
    if (requestGeneration !== generation.current || activeCommandId.current !== result.commandId) return;
    const value = accept(response);
    if (value) commandTerminal.current = value.status !== "pending";
    if (value) { setResult(value); setReadout({ state: "online", fixture: value.state }); }
  }

  useEffect(() => {
    let active = true;
    const requestGeneration = generation.current;
    if (bridge) void bridge.getFixture().then((response) => {
      if (!active || requestGeneration !== generation.current) return;
      const value = accept(response);
      if (value) setReadout(value);
    }).catch(() => { if (active && requestGeneration === generation.current) setError("尚未取得桌面工程状态。"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!bridge || !result || result.status !== "pending") return;
    let active = true;
    const currentGeneration = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async () => {
      try {
        const response = await bridge.readFixture(result.commandId);
        if (!active || currentGeneration !== generation.current || commandTerminal.current || activeCommandId.current !== result.commandId) return;
        const value = accept(response);
        if (!value) return;
        commandTerminal.current = value.status !== "pending";
        setResult(value); setReadout({ state: "online", fixture: value.state });
        if (value.status === "pending") {
          if (++attempts < 20) timer = setTimeout(poll, 100);
          else setError("命令仍未取得终态。保留原命令ID，显式回读或停止工程Core。");
        }
      } catch { if (active && currentGeneration === generation.current && activeCommandId.current === result.commandId && !commandTerminal.current) setError("Core已断开，不能把命令显示为成功。"); }
    };
    timer = setTimeout(poll, 100);
    return () => { active = false; clearTimeout(timer); };
  }, [result?.commandId, result?.status]);

  return <main className="engineering-shell">
    <header className="engineering-topbar"><strong>NetNavr</strong><span>产品 0.1 · 工程候选 / 流程评审</span></header>
    <div className="engineering-workspace">
      <nav className="engineering-sidebar" aria-label="工程与设计评审">
        <p className="sidebar-caption">当前可验证</p>
        <button aria-current={page === "engineering" ? "page" : undefined} onClick={() => setPage("engineering")}>工程往返</button>
        <p className="sidebar-caption">四组设计稿</p>
        {DESIGN_FLOWS.map((flow) => <button key={flow.id} aria-current={page === flow.id ? "page" : undefined} onClick={() => setPage(flow.id)}>{flow.title}<small>{flow.id}</small></button>)}
        <div className="scope-note">设计稿展示未来流程。任务、记忆、对话持久化、恢复及真实模型运行尚未接入。</div>
      </nav>
      <section className="engineering-content" ref={contentRef}>
        {page === "engineering" ? <>
          <div className="page-heading"><div><h1>受限工程往返</h1><p>仅使用隔离合成标记，真实 Core 回执驱动下方结果。首次打开不会启动服务、读取账号或调用模型。</p></div><span className="kind-badge">工程探针</span></div>
          <section className="engineering-card">
            <h2>本地工程服务</h2>
            <div className="engineering-actions">
              <button onClick={() => void action(start)} disabled={!bridge || busy || online}>显式启动 Core</button>
              <button onClick={() => void action(refresh)} disabled={!bridge || busy}>读取实际状态</button>
              <button onClick={() => void action(stop)} disabled={!bridge || busy || readout.state === "stopped"}>停止本App的 Core</button>
            </div>
            <p role="status">{!bridge ? "仅浏览器设计预览；没有桌面桥，不可执行工程命令。" : `当前状态：${readout.state}`}</p>
            <p className="scope-note">停止只处理本App创建的进程。关闭窗口保留当前会话；退出App停止该进程。重启保留隔离fixture标记与revision，命令账和session重新建立。</p>
          </section>
          <section className="engineering-card">
            <h2>唯一允许的写命令：设置合成标记</h2>
            <div className="fixture-inputs">
              <label>标记<select value={marker} onChange={(event) => setMarker(event.target.value as "alpha" | "beta")}><option value="alpha">alpha</option><option value="beta">beta</option></select></label>
              <label>测试延迟<select value={delayMs} onChange={(event) => setDelayMs(Number(event.target.value))}><option value="0">0 ms</option><option value="500">500 ms（观察取消）</option></select></label>
            </div>
            <div className="engineering-actions">
              <button disabled={!online || busy || pending} onClick={() => void action(() => submit({ commandId: `cmd_${crypto.randomUUID()}`, operation: "set-marker", marker, delayMs, timeoutMs: 1000 }))}>提交固定命令</button>
              <button disabled={!online || busy || !lastInput} onClick={() => lastInput && void action(() => submit(lastInput))}>重复同一请求</button>
              <button disabled={!online || busy || !pending} onClick={() => void action(cancel)}>取消当前命令</button>
            </div>
            <p className="scope-note">重复请求返回同一回执；取消不撤销已完成变更。本探针不执行Tasks、Memory、任意文本或模型工具。</p>
          </section>
          <section className="engineering-card" aria-live="polite"><h2>实际回读</h2>
            {readout.fixture ? <dl className="fixture-state"><div><dt>标记</dt><dd>{readout.fixture.marker}</dd></div><div><dt>Revision</dt><dd>{readout.fixture.revision}</dd></div><div><dt>持久化</dt><dd>{readout.fixture.persistence}</dd></div><div><dt>Session</dt><dd>{readout.fixture.fixtureSessionId}</dd></div></dl> : <p>尚无Core结果。</p>}
            {result ? <><p>命令状态：<strong>{result.status}</strong></p><code className="breakable">{result.commandId}</code></> : null}
            {error ? <p className="error-message" role="alert">{error}</p> : null}
          </section>
          <details className="engineering-card"><summary>工程来源与范围</summary><p>T3 Code固定快照 de251fc：桌面窗口/首次显示与自包含CJS构建策略的最小适配。Core HTTP v1、fixture-v1、数据Schema1。并未运行T3的编程领域数据库、远程服务或原工具权限。完整Mac工程、安装、升级、恢复及签名状态须以实机记录为准。</p></details>
          <section className="engineering-card"><h2>官方模型：权限边界尚未验证</h2><p>现有工具配置、hooks/MCP及文件访问范围未证明符合本版边界。此候选关闭真实模型运行；Core标记往返和设计稿都不能代替实际模型响应。官方工具的版本/认证探针结果与真实运行单独记录。</p></section>
        </> : <DesignReview key={page} flowId={page} />}
      </section>
    </div>
  </main>;
}

function DesignReview({ flowId }: { flowId: string }) {
  const flow = DESIGN_FLOWS.find((item) => item.id === flowId)!;
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState("请帮我整理明天需要做的事。\n这是一段可编辑的中文流程评审示例，尚未发送或保存。");
  const [taskTitle, setTaskTitle] = useState("整理出差安排");
  const [outbound, setOutbound] = useState(false);
  const [provider, setProvider] = useState("Codex");
  const state = flow.states[index];
  return <>
    <div className="page-heading"><div><h1>{flow.title}流程评审</h1><p>{flow.summary}</p></div><span className="kind-badge design-badge">设计稿 · 未实现</span></div>
    <div className="design-warning" role="note">所有按钮仅切换设计状态。本页不会调用模型、保存任务或记忆、读取备份、修改用户数据。</div>
    <div className="design-state-tabs" role="group" aria-label="设计状态">{flow.states.map((item, position) => <button key={item.name} aria-pressed={index === position} onClick={() => setIndex(position)}>{item.name}</button>)}</div>
    <section className="engineering-card design-preview"><h2>{state.name}</h2><p>{state.text}</p>
      {flow.id === "UI-03" ? <>
        <div className="design-messages" aria-label="合成对话示例">
          {index === 0 ? <p className="empty-design">没有真实会话。输入框可用于中文长文与换行评审。</p> : <>
            <article className="design-message user-message"><small>你 · 合成示例</small><p>请帮我整理明天需要做的事。</p></article>
            <article className="design-message"><small>Navigator · 合成示例</small><p>{index === 1 ? "正在整理候选建议……（设计状态）" : index === 4 ? "模型连接已中断，原输入仍在。" : "建议先整理出差安排，保存任务前将展示确认卡。此文案为设计示例。"}</p></article>
          </>}
        </div>
        <label>中文输入与长文评审<textarea aria-label="设计稿输入，尚未发送" value={draft} maxLength={64000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.trim()) setIndex(1); }
        }} /></label>
        <div className="design-controls"><span>Enter评审发送状态 · Shift+Enter换行</span><button onClick={() => setIndex(index === 1 ? 2 : 1)} disabled={!draft.trim()}>{index === 1 ? "停止" : "发送"} · 设计切换</button></div>
      </> : null}
      {flow.id === "UI-04" ? <div className="design-action-card">
        <strong>准备创建 · 尚未保存</strong>
        <label>标题<input value={taskTitle} onChange={(event) => { setTaskTitle(event.target.value); setIndex(1); }} maxLength={120} /></label>
        <dl><div><dt>日期</dt><dd>2026年10月2日（仅日期）</dd></div><div><dt>时区</dt><dd>Asia/Shanghai</dd></div><div><dt>参数变化</dt><dd>标题修改后重新确认</dd></div></dl>
        <div className="engineering-actions"><button onClick={() => setIndex(4)}>拒绝 · 设计</button><button onClick={() => setIndex(1)}>修改 · 设计</button><button disabled={index === 2 || !taskTitle.trim()} onClick={() => setIndex(2)}>确认保存 · 设计</button></div>
        <p className="scope-note">只展示结构化确认卡；Core的正式Tasks回执尚未实现。</p>
      </div> : null}
      {flow.id === "UI-06" ? <div className="design-action-card">
        <div className="design-memory-head"><strong>偏好中文回复</strong><span className="kind-badge">{index === 0 ? "候选" : index === 1 ? "已确认 · 仅本地（设计）" : "设计状态"}</span></div>
        <details><summary>查看来源与范围</summary><p>合成来源：2026年9月28日用户消息“请使用中文回复”；适用范围：表达偏好，不能扩大权限。</p></details>
        <label>指定Provider<select value={provider} onChange={(event) => { setProvider(event.target.value); setOutbound(false); }}><option>Codex</option><option>Claude</option></select></label>
        <label className="design-checkbox"><input type="checkbox" checked={outbound} onChange={(event) => setOutbound(event.target.checked)} />允许向{provider}发送此条记忆 · 设计授权</label>
        <div className="engineering-actions"><button onClick={() => setIndex(1)}>确认仅本地 · 设计</button><button disabled={!outbound} onClick={() => setIndex(2)}>确认指定外发 · 设计</button><button onClick={() => setIndex(3)}>遗忘 · 设计</button></div>
        <p className="scope-note">取消勾选只改变本页设计状态；真实产品需终止或重建已携带敏感上下文的原生会话。</p>
      </div> : null}
      {flow.id === "UI-08" ? <div className="design-action-card">
        <strong>合成恢复包预览 · 不是实际文件</strong>
        <dl><div><dt>来源</dt><dd>synthetic-design-only.nnrb</dd></div><div><dt>Navigator</dt><dd>示例Navigator</dd></div><div><dt>内容</dt><dd>12任务 / 8记忆 / 3对话（合成展示）</dd></div><div><dt>原库</dt><dd>保留；尚未切换</dd></div></dl>
        <ol className="design-steps"><li>格式、口令、兼容预检</li><li>新目录隔离恢复与引用核验</li><li>用户显式选择切换</li><li>官方模型重新认证</li></ol>
        <div className="engineering-actions"><button onClick={() => setIndex(1)}>开始预检 · 设计</button><button onClick={() => setIndex(2)}>查看隔离校验 · 设计</button><button onClick={() => setIndex(3)}>确认切换 · 设计</button><button onClick={() => setIndex(5)}>取消 · 设计</button></div>
        <p className="scope-note">本页没有读取文件、验证口令、恢复数据库或切换资料。</p>
      </div> : null}
      <button onClick={() => setIndex((index + 1) % flow.states.length)}>{state.action} · 设计切换</button>
    </section>
    <section className="engineering-card"><h2>Rex 评审点</h2><p>状态是否容易理解，关键确认与数据责任是否清楚，中文长文、窄窗口与浅深主题是否易读。人工结果记录于外部验收材料，AI不代勾选。</p></section>
  </>;
}
