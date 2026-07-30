// Overworked 皮肤系统 —— "约定大于配置"
//
// 皮肤目录结构（核心契约）：
//   skins/<皮肤名>/<动作>/1.png 2.png ...
//
// 文件夹名 = 动作名（18 个，见 ACTIONS 常量）
// 文件名 = 帧序号（1.png 2.png...，帧数任意）
// 缺失的动作 → 前端 fallback 到 idle
//
// Rust 侧职责：扫描文件系统（前端做不了），返回结构化数据。
// 前端职责：加载图片帧、播放动画、绑定交互。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 固定的动作清单（18 个，终极形态）。
/// idle 必须存在作为 fallback。顺序无功能意义，仅文档可读性。
pub const ACTIONS: &[&str] = &[
    // 状态动作（7）
    "idle",
    "working",
    "tired",
    "exhausted",
    "overworked",
    "nightshift",
    "happy",
    // 交互动作（2）
    "poke",
    "drag",
    // 生动动作（2）
    "walk",
    "jump",
    // 特殊事件动作（7）—— Phase 3，触发逻辑待实现，动作契约先备好
    "leave",        // 离职搬箱走
    "return",       // 新员工到岗
    "promoted",     // 升职戴铭牌
    "teambuilding", // 团建举杯
    "lunchnap",     // 午休趴睡
    "payday",       // 发工资数钱
    "vacation",     // 度假
];

/// 单个动作的帧信息。
#[derive(Debug, Clone, Serialize)]
pub struct ActionInfo {
    /// 帧数（该动作文件夹下 1.png..N.png 的数量）
    pub frames: u32,
}

/// 单个皮肤的描述。
#[derive(Debug, Clone, Serialize)]
pub struct SkinInfo {
    /// 皮肤名（文件夹名）
    pub name: String,
    /// 该皮肤下所有动作的帧数映射。
    /// key = 动作名，value = 帧数。缺失的动作不会出现在这里（前端 fallback 到 idle）。
    pub actions: BTreeMap<String, ActionInfo>,
}

/// 获取 skins 目录的绝对路径。
/// dev：项目根/skins（cwd 可能是 src-tauri，需向上找）
/// prod：打包后的 resource 目录/skins
fn skins_dir(app: &AppHandle) -> Option<PathBuf> {
    // prod 优先：打包资源目录
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("skins");
        if p.is_dir() {
            return Some(p);
        }
    }
    // dev：cwd 可能是项目根或 src-tauri，向上找最多 3 级
    if let Ok(mut cwd) = std::env::current_dir() {
        for _ in 0..3 {
            let p = cwd.join("skins");
            if p.is_dir() {
                return Some(p);
            }
            if !cwd.pop() {
                break;
            }
        }
    }
    // prod 回退：app local data 目录
    if let Ok(local_data) = app.path().app_local_data_dir() {
        let p = local_data.join("skins");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// 扫描单个皮肤目录，返回其所有动作的帧数。
fn scan_skin(skin_path: &Path) -> BTreeMap<String, ActionInfo> {
    let mut actions = BTreeMap::new();
    for action in ACTIONS {
        let action_dir = skin_path.join(action);
        if !action_dir.is_dir() {
            continue;
        }
        // 数该目录下的 png 帧数（1.png 2.png ...）
        let mut count = 0u32;
        loop {
            let frame = action_dir.join(format!("{}.png", count + 1));
            if frame.is_file() {
                count += 1;
            } else {
                break;
            }
        }
        if count > 0 {
            actions.insert(
                action.to_string(),
                ActionInfo { frames: count },
            );
        }
    }
    actions
}

/// 扫描所有皮肤。
pub fn scan_all_skins(app: &AppHandle) -> Vec<SkinInfo> {
    let mut skins = Vec::new();
    let Some(root) = skins_dir(app) else {
        eprintln!("[skin] skins 目录未找到（cwd={:?})", std::env::current_dir());
        return skins;
    };
    eprintln!("[skin] 扫描根目录: {}", root.display());
    let Ok(entries) = fs::read_dir(&root) else {
        return skins;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // 跳过隐藏目录
        if name.starts_with('.') {
            continue;
        }
        let actions = scan_skin(&path);
        // idle 是必须的（作为 fallback）
        if actions.contains_key("idle") {
            skins.push(SkinInfo { name, actions });
        }
    }
    // default 排前面
    skins.sort_by_key(|s| s.name != "default");
    skins
}

/// 读取一帧图片的原始字节（前端用 base64 加载，避免路径问题）。
/// 返回 (base64_data_url, frame_count_of_this_action)。
pub fn read_frame(app: &AppHandle, skin: &str, action: &str, frame: u32) -> Option<String> {
    let root = skins_dir(app)?;
    let path = root.join(skin).join(action).join(format!("{frame}.png"));
    let bytes = fs::read(&path).ok()?;
    let b64 = base64_encode(&bytes);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 简易 base64 编码（避免引入额外 crate）。
fn base64_encode(input: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 2 < input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | input[i + 2] as u32;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push(CHARS[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(CHARS[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

// ===== Tauri commands =====

/// 列出所有可用皮肤。
#[tauri::command]
pub fn list_skins(app: AppHandle) -> Vec<SkinInfo> {
    scan_all_skins(&app)
}

/// 读取指定皮肤某动作某帧的图片（base64 data url）。
#[tauri::command]
pub fn read_skin_frame(app: AppHandle, skin: String, action: String, frame: u32) -> Option<String> {
    read_frame(&app, &skin, &action, frame)
}

/// 切换皮肤（emit 事件通知前端重新加载）。
#[tauri::command]
pub fn switch_skin(app: AppHandle, skin: String) -> Result<(), String> {
    // 校验皮肤存在
    let skins = scan_all_skins(&app);
    if !skins.iter().any(|s| s.name == skin) {
        return Err(format!("皮肤 '{skin}' 不存在"));
    }
    let _ = app.emit("skin-switched", &skin);
    Ok(())
}
