/**
 * Debug panel, a thin wrapper over lil-gui.
 *
 * Same reasoning as the HUD: the master plan requires every new subsystem to
 * get a toggle, so subsystems register their own controls instead of this file
 * growing a hardcoded list.
 *
 * Hidden by `?panel=0`, which every canonical screenshot forces.
 */

import GUI from 'lil-gui';

export class DebugPanel {
  private readonly gui: GUI;
  private isVisible: boolean;

  constructor(options: { visible?: boolean; title?: string } = {}) {
    const visible = options.visible ?? true;
    this.gui = new GUI({ title: options.title ?? 'Debug' });
    this.isVisible = visible;
    this.applyVisibility();
  }

  /** A named sub-panel, so each subsystem owns a section. */
  folder(name: string): DebugFolder {
    return new DebugFolder(this.gui.addFolder(name));
  }

  /** Controls that do not belong to any particular subsystem. */
  get root(): DebugFolder {
    return new DebugFolder(this.gui);
  }

  setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.applyVisibility();
  }

  get visible(): boolean {
    return this.isVisible;
  }

  destroy(): void {
    this.gui.destroy();
  }

  private applyVisibility(): void {
    this.gui.domElement.style.display = this.isVisible ? '' : 'none';
  }
}

/**
 * lil-gui binds to object properties, so each control gets a small proxy object
 * whose property reads and writes are forwarded to the supplied accessors. That
 * keeps subsystems free to own their own state instead of handing it to the GUI.
 */
export class DebugFolder {
  constructor(private readonly gui: GUI) {}

  addToggle(label: string, get: () => boolean, set: (value: boolean) => void): void {
    const proxy = { value: get() };
    this.gui
      .add(proxy, 'value')
      .name(label)
      .onChange((value: boolean) => set(value));
  }

  addNumber(
    label: string,
    get: () => number,
    set: (value: number) => void,
    range: { min: number; max: number; step?: number },
  ): void {
    const proxy = { value: get() };
    const controller = this.gui
      .add(proxy, 'value', range.min, range.max)
      .name(label)
      .onChange((value: number) => set(value));
    if (range.step !== undefined) controller.step(range.step);
  }

  addText(label: string, get: () => string, set: (value: string) => void): void {
    const proxy = { value: get() };
    this.gui
      .add(proxy, 'value')
      .name(label)
      .onFinishChange((value: string) => set(value));
  }

  addButton(label: string, action: () => void): void {
    const proxy = { [label]: action };
    this.gui.add(proxy, label);
  }

  folder(name: string): DebugFolder {
    return new DebugFolder(this.gui.addFolder(name));
  }
}
