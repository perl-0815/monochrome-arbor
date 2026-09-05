"use client";

import { useEffect, useRef, useState } from "react";
import { ArborRenderer } from "@/lib/arbor-renderer";
import { MODES, NODE_ROLES, type GrowthMode, type NodeRole } from "@/lib/arbor";
import styles from "./ProceduralArbor.module.css";

function Icon({ name }: { name: "seed" | "pause" | "play" | "contrast" | "expand" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === "seed" && <><path d="M18.5 8a7.5 7.5 0 1 0 .8 6M18.5 3.5V8H14" /><path d="m12 8 4 4-4 4-4-4Z" /></>}
      {name === "pause" && <path d="M9 6v12M15 6v12" />}
      {name === "play" && <path d="m9 6 9 6-9 6Z" />}
      {name === "contrast" && <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15Z" fill="currentColor" stroke="none" /></>}
      {name === "expand" && <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />}
    </svg>
  );
}

export function ProceduralArbor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ArborRenderer | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const [mode, setMode] = useState<GrowthMode>("canopy");
  const [generation, setGeneration] = useState(1);
  const [paused, setPaused] = useState(false);
  const [light, setLight] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<{ id: number; role: NodeRole } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modeInfo = MODES.find((item) => item.id === mode)!;
  const roleInfo = NODE_ROLES.find((item) => item.role === selection?.role);

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new ArborRenderer(canvasRef.current, () => {
      setTouched(true);
      setPaused(false);
    }, setSelection);
    engineRef.current = renderer;
    return () => {
      renderer.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => { engineRef.current?.regenerate(mode); }, [generation, mode]);
  useEffect(() => { engineRef.current?.setPaused(paused); }, [paused]);
  useEffect(() => { engineRef.current?.setLight(light); }, [light]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const regenerate = (nextMode = mode) => {
    setMode(nextMode);
    setGeneration((value) => value + 1);
    setPaused(false);
    setSelection(null);
    setMenuOpen(false);
    if (menuOpen) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    setNotice(`${MODES.find((item) => item.id === nextMode)!.label}の新しい木が育ち始めました。`);
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
        aria-label="信号を交わしながら育つ木"
        aria-describedby="arbor-instruction arbor-keyboard-instruction"
      />
      <p id="arbor-keyboard-instruction" className={styles.srOnly}>
        矢印キーでノードを選び、Enterキーで選んだノードに信号を送ります。スペースキーで枝が育ちます。
      </p>
      <header className={styles.header}>
        <div className={styles.identity}>
          <svg className={styles.mark} viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 28V15m0 7L7 13V7m9 11 9-9V4M16 15l-5-5m5 3V4" />
            <path d="m16 1 3 3-3 3-3-3ZM4 4h6v6H4Zm18-3h6v6h-6Z" />
          </svg>
          <h1>MONOCHROME <span>ARBOR</span></h1>
        </div>
        <button className={styles.fullscreen} onClick={fullscreen} aria-label="全画面表示を切り替え" title="全画面表示">
          <Icon name="expand" />
        </button>
      </header>
      <div className={styles.edition} aria-hidden="true">
        <span className={styles.liveDot} data-paused={paused} />
        {String(generation).padStart(3, "0")} <span>/</span> {modeInfo.label}
      </div>
      <div className={styles.inspector} data-active={!!roleInfo} role="status" aria-live="polite" aria-atomic="true">
        {roleInfo && <>
          <p className={styles.inspectorTitle}><strong>{roleInfo.label}</strong><span aria-hidden="true">{roleInfo.role}</span></p>
          <p className={styles.inspectorDescription}>{roleInfo.description}</p>
        </>}
      </div>
      <div className={styles.footer}>
        <p id="arbor-instruction" className={styles.instruction} data-touched={touched}>
          触れて、つながる。
          <span>ノードに触れると信号を送り、余白に触れると枝が育ちます</span>
        </p>
        <nav className={styles.controls} aria-label="作品のコントロール">
          <div className={styles.modePicker} ref={menuRef}>
            <button className={styles.modeButton} aria-expanded={menuOpen} aria-controls="growth-modes" onClick={() => setMenuOpen((value) => !value)} title="木の生成方法を選ぶ">
              <span className={styles.modeNumber}>{String(MODES.findIndex((item) => item.id === mode) + 1).padStart(2, "0")}</span>
              {modeInfo.label}
              <svg viewBox="0 0 12 12" aria-hidden="true" data-open={menuOpen}><path d="m3 7 3-3 3 3" /></svg>
            </button>
            {menuOpen && (
              <div className={styles.modeMenu} id="growth-modes" role="group" aria-label="生成方法">
                <p>GROWTH FORMS</p>
                {MODES.map((item, index) => (
                  <button key={item.id} onClick={() => regenerate(item.id)} aria-pressed={item.id === mode}>
                    <span className={styles.menuIndex}>0{index + 1}</span>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    <span className={styles.selectedDot} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className={styles.divider} />
          <button className={styles.regenerate} onClick={() => regenerate()} title="別の種から育てる" aria-label="新しい木を生成">
            <Icon name="seed" /><span>新しい木</span>
          </button>
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
