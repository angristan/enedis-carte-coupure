import { useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly appearance: "always" | "interaction-only";
      readonly size: "flexible";
      readonly action: string;
      readonly retry: "never";
      readonly "response-field": false;
      readonly callback: (token: string) => void;
      readonly "error-callback": (code: string) => void;
      readonly "expired-callback": () => void;
      readonly "timeout-callback": () => void;
      readonly "unsupported-callback": () => void;
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
  const [forceVisible, setForceVisible] = useState(false);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [canRetry, setCanRetry] = useState(false);
  const [message, setMessage] = useState("Vérification de sécurité...");

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let active = true;
    let submitting = false;
    let widgetId: string | undefined;

    setCanRetry(false);
    setMessage(
      forceVisible
        ? "Confirmez que vous êtes humain."
        : "Vérification de sécurité...",
    );

    const showVisibleFallback = (nextMessage: string): void => {
      if (!active) return;
      setMessage(nextMessage);
      if (forceVisible) setCanRetry(true);
      else setForceVisible(true);
    };

    void loadTurnstile().then(() => {
      if (!active || containerRef.current === null) return;
      if (window.turnstile === undefined) {
        showVisibleFallback("La vérification est indisponible.");
        return;
      }

      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        appearance: forceVisible ? "always" : "interaction-only",
        size: "flexible",
        action: "outages_access",
        retry: "never",
        "response-field": false,
        callback: (token) => {
          if (submitting) return;
          submitting = true;
          setMessage("Validation en cours...");
          void onTokenRef.current(token).then((verified) => {
            if (!active || verified) return;
            submitting = false;
            showVisibleFallback("La vérification a échoué.");
          }).catch(() => {
            submitting = false;
            showVisibleFallback("La vérification est indisponible.");
          });
        },
        "error-callback": (code) => {
          showVisibleFallback(`La vérification a échoué (code ${code}).`);
        },
        "expired-callback": () => {
          showVisibleFallback("La vérification a expiré.");
        },
        "timeout-callback": () => {
          showVisibleFallback("La vérification a expiré.");
        },
        "unsupported-callback": () => {
          showVisibleFallback("Ce navigateur ne peut pas effectuer la vérification.");
        },
      });
    }).catch(() => {
      showVisibleFallback("La vérification est indisponible.");
    });

    return () => {
      active = false;
      if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    };
  }, [forceVisible, renderAttempt, siteKey]);

  return (
    <div className="verification-overlay" role="dialog" aria-live="polite">
      <div className="verification-card">
        <div className="verification-widget" ref={containerRef} />
        <p>{message}</p>
        {canRetry
          ? (
            <button
              type="button"
              onClick={() => setRenderAttempt((attempt) => attempt + 1)}
            >
              Réessayer
            </button>
          )
          : null}
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
      existing.addEventListener("error", () => {
        existing.remove();
        reject(new Error("Turnstile failed"));
      }, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("Turnstile failed"));
    }, { once: true });
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = undefined;
    throw error;
  });
  return scriptPromise;
}
