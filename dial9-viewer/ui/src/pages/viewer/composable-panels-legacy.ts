import "../../components/panels/panels.css";
import {
  cpuPanel,
  type CpuPanelInput,
} from "../../components/panels/fixtures.js";
import {
  mountPanelRuntime,
  type PanelRuntime,
  type PanelViewport,
} from "../../components/panels/runtime.js";

interface LegacyMountOptions {
  readonly container: HTMLElement;
  readonly before: HTMLElement;
  readonly tooltip: HTMLElement;
  readonly isCollapsed: (key: string) => boolean;
  readonly onPanelCreated: (panel: HTMLElement) => void;
  readonly onPointerTime?: (timestamp: number | null) => void;
}

interface LegacyPanelData {
  readonly cpu: CpuPanelInput;
}

interface LegacyPanelSession {
  setData(data: LegacyPanelData): void;
  clear(): void;
  render(viewport: PanelViewport): void;
  dispose(): void;
}

interface LegacyPanelApi {
  mount(options: LegacyMountOptions): LegacyPanelSession;
}

function mount(options: LegacyMountOptions): LegacyPanelSession {
  const runtime: PanelRuntime = mountPanelRuntime(options);
  return {
    setData(data) {
      const cpu = cpuPanel(data.cpu);
      runtime.setPanels(cpu === null ? [] : [cpu]);
      for (const element of runtime.elements) element.style.display = "block";
    },
    clear() {
      runtime.setPanels([]);
    },
    render(viewport) {
      runtime.render(viewport);
    },
    dispose() {
      runtime.dispose();
    },
  };
}

const api: LegacyPanelApi = Object.freeze({ mount });

declare global {
  interface Window {
    Dial9ComposablePanels?: LegacyPanelApi;
  }
}

window.Dial9ComposablePanels = api;
window.dispatchEvent(new Event("dial9-composable-panels-ready"));
