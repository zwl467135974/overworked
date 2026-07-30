# Overworked

> 一只住在屏幕角落的像素打工仔。你用电脑，它就在打工。
> 你加班它受伤，你摸鱼它瘫倒，你卷它就卷。你以为在养宠物，其实在养你自己的镜子。

## 状态

🚧 开发中 — v0.1.0

## 功能

- **行为感知**：感知你的打字频率、挂机时长、熬夜时段
- **状态映射**：体力/心情/存款/时薪四属性，打字消耗挂机恢复
- **18 种动作**：idle/working/tired/exhausted/overworked/nightshift/happy + poke/drag/walk/jump + leave/return/promoted/teambuilding/lunchnap/payday/vacation
- **皮肤系统**：按命名规则放图即可换皮肤，支持任意尺寸/风格
- **特殊事件**：番茄钟/过劳送医/离职回归/升职/度假/团建/午休/发工资
- **趣味玩法**：Boss 来了/投喂咖啡/每日语录/成就系统
- **打字特效**：全屏粒子爆裂（发光+冲击波+震屏）
- **桌面物理**：拖到空中掉落+弹跳+沿底边走
- **本地存档**：离线睡觉恢复+位置记忆+统计
- **系统托盘**：不占任务栏但随时可找到

## 技术栈

- Tauri 2（桌面端，轻量常驻）
- Rust（行为感知 + 游戏逻辑 + 存档）
- Canvas（动画渲染 + 粒子特效）
- SQLite（本地存档）
- rdev（全局键盘/鼠标感知，**只记频率不记内容**）

## 原则

- 不爹味：它只反应，不教育
- 本地优先：零账号、零联网、零隐私焦虑
- 反差是灵魂：可爱 × 社畜的错位

## 快速开始

```bash
# 开发模式
npm install
npm run tauri dev

# 打包
npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/Overworked_0.1.0_x64-setup.exe

# 生成默认皮肤占位图
node scripts/generate-skin.cjs
```

## 文档

- [PRD](docs/PRD.md) — 产品需求文档
- [皮肤制作指南](docs/SKIN_GUIDE.md) — 美术向，18 动作设计规范
- [AGENTS.md](AGENTS.md) — AI 协作规则 + 设计红线

---

> 它替你打工，你替它活着。
