// Product 0.1 review prototypes. These do not invoke product data or a provider.
export type DesignFlow = {
  id: string;
  title: string;
  summary: string;
  states: { name: string; text: string; action: string }[];
};
export const DESIGN_FLOWS: readonly DesignFlow[] = [
  { id: "UI-03", title: "对话", summary: "保留用户原文，清楚说明运行、取消、断线与重试。",
    states: [
      { name: "空会话", text: "还没有对话。模型未连接时可以查看本地资料。", action: "准备发送" },
      { name: "运行中", text: "仅一个活动运行；页面切换保留该运行。输出尚未代表任务已保存。", action: "请求停止" },
      { name: "取消中", text: "等待服务端终态；旧运行的后续事件不能污染新运行。", action: "查看已取消" },
      { name: "已取消", text: "保留输入；取消不撤销此前已提交的数据变更。", action: "查看连接中断" },
      { name: "离线 / 错误", text: "原文仍在，说明本地服务与模型故障来源；用户显式重试，避免无限重试消耗额度。", action: "返回空会话" },
      { name: "重启回读（设计）", text: "同一会话历史应从Core恢复，旧运行标为interrupted而非自动重放；保留尚未发送的输入。", action: "返回空会话" },
    ] },
  { id: "UI-04", title: "任务确认", summary: "模型建议与真正保存分开；拒绝或参数变化需要清楚反馈。",
    states: [
      { name: "待确认", text: "准备创建：整理出差安排。日期：2026年10月2日，仅日期，时区Asia/Shanghai。确认前尚未写入。", action: "查看参数修改" },
      { name: "参数修改", text: "日期或标题改变后重新确认新的内容；旧卡片授权失效。", action: "查看执行中" },
      { name: "执行中", text: "同一确认请求重复点击不得创建多条任务。只有Core提交成功才能显示已保存。", action: "查看成功" },
      { name: "成功（设计状态）", text: "真正产品实现必须以Core回执驱动此状态，本设计稿没有保存任务。", action: "查看拒绝 / 冲突" },
      { name: "拒绝 / 失败 / 修改冲突", text: "拒绝不保存；失败保留卡片；任务已被修改时刷新再确认。", action: "返回待确认" },
      { name: "离线 / 取消 / 恢复", text: "本地服务离线时不宣布保存；待执行前取消不写入；恢复连接后查询原请求回执再决定，避免重复任务。", action: "返回待确认" },
    ] },
  { id: "UI-06", title: "记忆", summary: "保存记忆与允许外发是独立决定；来源与遗忘责任可查看。",
    states: [
      { name: "候选", text: "建议记住：你偏好中文回复。来源：用户消息。候选尚未持久保存，也不发送给模型。", action: "查看仅本地确认" },
      { name: "已确认 · 仅本地", text: "保存和外发分别控制；未批准的新Provider不能取得本条记忆。", action: "查看外发授权" },
      { name: "允许指定Provider外发", text: "本轮上下文应展示具体来源与范围；预算不足必须明确摘要或截断。", action: "查看修改 / 遗忘" },
      { name: "修改 / 遗忘", text: "未来停止使用并清理派生缓存；已有原始消息、云端内容和旧备份范围另行说明。", action: "查看错误" },
      { name: "拒绝 / 错误", text: "授权失效或版本冲突时失败关闭，不能悄悄发送旧内容。", action: "返回候选" },
      { name: "空 / 离线 / 取消 / 重启", text: "空列表明确没有已确认记忆；模型离线仍可管理本地条目；取消确认不保存；重启从Core恢复授权范围。", action: "返回候选" },
    ] },
  { id: "UI-08", title: "恢复", summary: "先检查，再在新目录恢复，最后由用户决定切换。",
    states: [
      { name: "没有恢复包", text: "备份包含版本化业务数据与加密身份材料，不含Provider登录和待执行授权。", action: "查看预检" },
      { name: "预检", text: "展示备份时间、Navigator、Schema和数据数量，检查资源上限及完整性。", action: "查看隔离校验" },
      { name: "隔离恢复校验", text: "新目录核验身份、引用、迁移和数量。原库仍可使用，尚未切换。", action: "查看可切换" },
      { name: "可切换（设计状态）", text: "资料已校验；官方模型需重新认证。仅显式确认才切换使用恢复资料。", action: "查看失败保护" },
      { name: "错误口令 / 损坏 / 过新版本", text: "保留原库与失败证据；不把换旧App当成必然可回滚数据。", action: "返回入口" },
      { name: "取消 / 离线 / 恢复完成", text: "取消预检或隔离恢复不修改原库；模型离线不阻碍资料恢复，成功切换后模型仍需官方重新认证。", action: "返回入口" },
    ] },
];
