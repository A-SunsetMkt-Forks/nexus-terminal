import type { ITheme } from 'xterm';

/**
 * 外观设置数据结构
 */
export interface AppearanceSettings {
  _id?: string; // 通常只有一个文档，ID 固定或不使用
  userId?: string; // 如果需要区分用户设置 (当前假设为全局)
  customUiTheme?: string; // UI 主题 (CSS 变量 JSON 字符串)
  activeTerminalThemeId?: number | null; // 修改为数字 ID 或 null
  terminalFontFamily?: string; // 终端字体列表字符串
  terminalFontSize?: number; // 终端字体大小 (px)
  terminalBackgroundImage?: string; // 终端背景图片 URL 或路径
  pageBackgroundImage?: string; // 页面背景图片 URL 或路径
  editorFontSize?: number; // 编辑器字体大小 (px)
  updatedAt?: number;
}

/**
 * 用于更新外观设置的数据结构 (所有字段可选)
 */
export type UpdateAppearanceDto = Partial<Omit<AppearanceSettings, '_id' | 'userId' | 'updatedAt'>>;
