import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PwaInstallProvider } from '../../src/client/components/PwaInstallProvider';

/**
 * 和 `render` 相同，但包在 `PwaInstallProvider` 底下，讓用到 `usePwaInstall` 的元件（推播按鈕、安裝橫幅）能單獨渲染。
 * `rerender` 會沿用同一個 provider，所以安裝狀態在重新渲染之間保持。
 */
export function renderWithPwaInstall(ui: ReactElement, options?: RenderOptions): RenderResult {
  return render(ui, { wrapper: PwaInstallProvider, ...options });
}
