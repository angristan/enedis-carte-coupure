import { useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly appearance: "interaction-only";
      readonly action: string;
      readonly callback: (token: string) => void;
      readonly "error-callback": () => void;
      readonly "expired-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface TurnstileGateProps {
  readonly siteKey: string;
  readonly onToken: (token: string) => Promise<boolean>;
}

let scriptPromise: Promise<void> | undefined;

export function TurnstileGate({ siteKey, onToken }: TurnstileGateProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  const [message, setMessage] = useState("Vérification de sécurité...");

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let active = true;
    let widgetId: string | undefined;

    void loadTurnstile().then(() => {
      if (!active || containerRef.current === null || window.turnstile === undefined) {
        return;
      }
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        appearance: "interaction-only",
        action: "outages_access",
        callback: (token) => {
          setMessage("Validation en cours...");
          void onTokenRef.current(token).then((verified) => {
            if (!active || verified) return;
            setMessage("La vérification a échoué. Réessayez.");
            if (widgetId !== undefined) window.turnstile?.reset(widgetId);
          });
        },
        "error-callback": () => {
          setMessage("La vérification est indisponible. Réessayez.");
        },
        "expired-callback": () => {
          setMessage("La vérification a expiré. Réessayez.");
          if (widgetId !== undefined) window.turnstile?.reset(widgetId);
        },
      });
    }).catch(() => {
      if (active) setMessage("La vérification est indisponible.");
    });

    return () => {
      active = false;
      if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  return (
    <div className="verification-overlay" role="dialog" aria-live="polite">
      <div className="verification-card">
        <div ref={containerRef} />
        <p>{message}</p>
      </div>
    </div>
  );
}

function loadTurnstile(): Promise<void> {
  if (window.turnstile !== undefined) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT}"]`,
    );
    if (existing !== null) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile failed")), {
        once: true,
      });
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile failed")), {
      once: true,
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}
