// packages/frontend/src/types/appearance.types.ts

// 前端使用的外观设置结构 (对应 API 响应)
export interface AppearanceSettings {
  // 注意：前端可能不需要 _id, userId, updatedAt 等数据库相关的字段
  // 但为了与后端导入保持一致，暂时保留，后续可根据 API 精简
  customUiTheme?: string; // CSS 变量 JSON 字符串
  activeTerminalThemeId?: number | null; // 终端主题 ID
  terminalFontFamily?: string;
  terminalFontSize?: number;
  terminalBackgroundImage?: string;
  pageBackgroundImage?: string;
  editorFontSize?: number;
}

// 前端用于更新外观设置的数据结构 (对应 API 请求体)
// 使用 Partial<AppearanceSettings> 也可以，但明确定义更清晰
export type UpdateAppearanceDto = Partial<AppearanceSettings>;