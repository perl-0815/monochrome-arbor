"use client";

import { useEffect, useRef, useState } from "react";
import { ArborRenderer } from "@/lib/arbor-renderer";
import { MODES, NODE_ROLES, type GrowthMode, type NodeRole } from "@/lib/arbor";
import styles from "./ProceduralArbor.module.css";

function Icon({ name }: { name: "seed" | "pause" | "play" | "contrast" | "expand" | "add" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === "seed" && <><path d="M18.5 8a7.5 7.5 0 1 0 .8 6M18.5 3.5V8H14" /><path d="m12 8 4 4-4 4-4-4Z" /></>}
      {name === "pause" && <path d="M9 6v12M15 6v12" />}
      {name === "play" && <path d="m9 6 9 6-9 6Z" />}
      {name === "contrast" && <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15Z" fill="currentColor" stroke="none" /></>}
      {name === "expand" && <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />}
      {name === "add" && <path d="M12 5v14M5 12h14" />}
    </svg>
  );
}

function RoleGlyph({ role }: { role: NodeRole }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {role === "source" && <><path d="m12 3 9 9-9 9-9-9Z" /><circle cx="12" cy="12" r="4" /></>}
      {role === "relay" && <><path d="M7 7h10v10H7Z" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></>}
      {role === "amplifier" && <><path d="m12 3 8 14H4Z" /><path d="m8.5 12 3.5-5 3.5 5" /></>}
      {role === "collector" && <><path d="m21 12-4.5 7.8h-9L3 12l4.5-7.8h9Z" /><path d="M19.5 12h-5M8.3 5.5l2.5 4.3M8.3 18.5l2.5-4.3" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>}
      {role === "capacitor" && <><circle cx="12" cy="12" r="8" /><path d="M10 7.5v9M14 7.5v9" /></>}
      {role === "splitter" && <><path d="m12 3 9 9-9 9-9-9Z" /><path d="M12 17v-5m-4-2 4 2 4-2" /></>}
      {role === "gate" && <><path d="M6 6h12v12H6Z" /><path d="M12 7v10" /></>}
      {role === "echo" && <><circle cx="12" cy="12" r="3.8" /><path d="M6.1 7.7a7.3 7.3 0 1 1 0 8.6M8 3.9a9 9 0 1 1 0 16.2" /></>}
    </svg>
  );
}

function GrowthGlyph({ mode }: { mode: GrowthMode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {mode === "canopy" && <path d="M12 21V11M12 16l-7-7V5m7 8 7-7V3M12 11 8 7m4 2V3M5 9H2m17-3h3" />}
      {mode === "spire" && <path d="M12 22V2M12 17l-7-4v-3m7 3 7-4V6m-7 3L8 6V3m4 3 4-3" />}
      {mode === "rhizome" && <path d="M3 18h5l4-4V9l5-5h4M8 18v4m4-8h7l3-3M12 9H6L3 6m14-2V1" />}
    </svg>
  );
}

export function ProceduralArbor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ArborRenderer | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<GrowthMode>("canopy");
  const [generation, setGeneration] = useState(1);
  const [paused, setPaused] = useState(false);
  const [light, setLight] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [placementRole, setPlacementRole] = useState<NodeRole | null>(null);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<{ id: number; role: NodeRole } | null>(null);
  const modeInfo = MODES.find((item) => item.id === mode)!;
  const roleInfo = NODE_ROLES.find((item) => item.role === selection?.role);
  const placementInfo = NODE_ROLES.find((item) => item.role === placementRole);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ArborRenderer(canvasRef.current, () => {
      setPaused(false);
    }, setSelection, setPlacementRole, setNotice);
    engineRef.current = renderer;
    return () => {
      renderer.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => { engineRef.current?.regenerate(mode); }, [generation, mode]);
  useEffect(() => { engineRef.current?.setPaused(paused); }, [paused]);
  useEffect(() => { engineRef.current?.setLight(light); }, [light]);
  useEffect(() => { engineRef.current?.setPlacementRole(placementRole); }, [placementRole]);

  useEffect(() => {
    if (!menuOpen && !paletteOpen && !placementRole) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
      if (!paletteRef.current?.contains(event.target as Node)) setPaletteOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menuOpen) modeButtonRef.current?.focus();
      else addButtonRef.current?.focus();
      setMenuOpen(false);
      setPaletteOpen(false);
      setPlacementRole(null);
      if (placementRole) setNotice("ノードの追加を取り消しました。");
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen, paletteOpen, placementRole]);

  const regenerate = (nextMode = mode) => {
    setMode(nextMode);
    setGeneration((value) => value + 1);
    setPaused(false);
    setSelection(null);
    setPlacementRole(null);
    setPaletteOpen(false);
    setMenuOpen(false);
    if (menuOpen) modeButtonRef.current?.focus();
    setNotice(`${MODES.find((item) => item.id === nextMode)!.label}の新しい木が育ち始めました。`);
  };

  const togglePalette = () => {
    setMenuOpen(false);
    if (placementRole) {
      setPlacementRole(null);
      setPaletteOpen(false);
      setNotice("ノードの追加を取り消しました。");
    } else {
      setPaletteOpen((value) => !value);
    }
  };

  const selectRole = (role: NodeRole) => {
    setPlacementRole(role);
    setPaletteOpen(false);
    setSelection(null);
    setNotice(`${NODE_ROLES.find((item) => item.role === role)!.label}を追加します。好きな場所に触れるか、矢印キーで位置を動かしてEnterキーで配置します。Escapeキーで取り消します。`);
    canvasRef.current?.focus({ preventScroll: true });
  };

  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shellRef.current?.requestFullscreen) await shellRef.current.requestFullscreen();
      else setNotice("このブラウザーでは全画面表示に対応していません。");
    } catch {
      setNotice("全画面表示を開始できませんでした。");
    }
  };

  return (
    <main ref={shellRef} className={styles.shell} data-light={light}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        tabIndex={0}
        role="button"
        aria-label={placementInfo ? `${placementInfo.label}ノードの配置場所` : "信号を交わしながら育つ木"}
        aria-describedby="arbor-instruction arbor-keyboard-instruction"
      />
      <p id="arbor-instruction" className={styles.srOnly}>
        ノードに触れると信号を送り、余白に触れると枝が育ちます。追加ボタンから役割を選び、好きな場所に触れるとノードをひとつ追加できます。
      </p>
      <p id="arbor-keyboard-instruction" className={styles.srOnly}>
        {placementRole
          ? "矢印キーで配置場所を動かし、Enterキーまたはスペースキーでノードを追加します。Escapeキーで取り消します。"
          : "矢印キーでノードを選び、Enterキーで選んだノードに信号を送ります。スペースキーで枝が育ちます。"}
      </p>
      <header className={styles.header}>
        <div className={styles.identity}>
          <svg className={styles.mark} viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 28V15m0 7L7 13V7m9 11 9-9V4M16 15l-5-5m5 3V4" />
            <path d="m16 1 3 3-3 3-3-3ZM4 4h6v6H4Zm18-3h6v6h-6Z" />
          </svg>
          <h1 className={styles.srOnly}>MONOCHROME ARBOR</h1>
        </div>
        <button className={styles.fullscreen} onClick={fullscreen} aria-label="全画面表示を切り替え" title="全画面表示">
          <Icon name="expand" />
        </button>
      </header>
      <div className={styles.inspector} data-active={!!roleInfo && !placementRole} role="status" aria-live="polite" aria-atomic="true" title={roleInfo?.description}>
        {roleInfo && <>
          <RoleGlyph role={roleInfo.role} />
          <span>{roleInfo.label}</span>
          <span className={styles.srOnly}>：{roleInfo.description}</span>
        </>}
      </div>
      <div className={styles.footer}>
        {placementInfo && <div className={styles.placementHint} aria-hidden="true">
          <RoleGlyph role={placementInfo.role} /><span>{placementInfo.label}</span>
        </div>}
        <nav className={styles.controls} aria-label="作品のコントロール">
          <div className={styles.picker} ref={menuRef}>
            <button ref={modeButtonRef} className={styles.iconButton} aria-label={`生成方法を選ぶ：${modeInfo.label}`} aria-expanded={menuOpen} aria-controls="growth-modes" onClick={() => {
              setPaletteOpen(false);
              setPlacementRole(null);
              setMenuOpen((value) => !value);
            }} title="生成方法">
              <GrowthGlyph mode={mode} />
            </button>
            {menuOpen && (
              <div className={styles.modeMenu} id="growth-modes" role="group" aria-label="生成方法">
                {MODES.map((item) => (
                  <button key={item.id} onClick={() => regenerate(item.id)} aria-pressed={item.id === mode} title={item.description}>
                    <GrowthGlyph mode={item.id} />
                    <span>{item.label}</span>
                    <span className={styles.selectedDot} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={`${styles.iconButton} ${styles.regenerate}`} onClick={() => regenerate()} title="新しい木" aria-label="新しい木を生成">
            <Icon name="seed" />
          </button>
          <span className={styles.divider} />
          <div className={styles.picker} ref={paletteRef}>
            <button ref={addButtonRef} className={`${styles.iconButton} ${styles.addButton}`} onClick={togglePalette} aria-label={placementRole ? "ノードの追加を取り消す" : "ノードを追加"} aria-pressed={paletteOpen || !!placementRole} aria-expanded={paletteOpen} aria-controls="node-roles" title={placementRole ? "追加を取り消す" : "ノードを追加"}>
              <Icon name="add" />
            </button>
            {paletteOpen && <div className={styles.rolePalette} id="node-roles" role="group" aria-label="追加するノードの役割">
              {NODE_ROLES.map((item) => <button key={item.role} className={styles.roleButton} onClick={() => selectRole(item.role)} aria-label={`${item.label}ノードを追加：${item.description}`} title={`${item.label} — ${item.description}`}>
                <RoleGlyph role={item.role} />
                <span aria-hidden="true">{item.label}</span>
              </button>)}
            </div>}
          </div>
          <span className={styles.divider} />
          <button className={styles.iconButton} onClick={() => setPaused((value) => !value)} aria-label={paused ? "成長を再開" : "成長を一時停止"} aria-pressed={paused} title={paused ? "成長を再開" : "一時停止"}>
            <Icon name={paused ? "play" : "pause"} />
          </button>
          <button className={styles.iconButton} onClick={() => setLight((value) => !value)} aria-label="白黒を反転" aria-pressed={light} title="白黒を反転">
            <Icon name="contrast" />
          </button>
        </nav>
      </div>
      <p className={styles.srOnly} role="status">{notice}</p>
    </main>
  );
}
