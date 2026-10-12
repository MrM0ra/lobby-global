
import { useEffect, useRef, useState } from "react";
import { supabase } from "./lib/supabase";
import "./App.css";

const SESSION_STORAGE_KEY = "global-lobby-session";

function getSessionId() {
  let id = sessionStorage.getItem(SESSION_STORAGE_KEY);

  if (!id) {
    id = generateUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  }

  return id;
}

function readPresence(channel) {
  const state = channel.presenceState();
  const participants = new Map();

  Object.values(state)
    .flat()
    .forEach((presence) => {
      if (presence.sessionId && presence.name) {
        participants.set(presence.sessionId, {
          sessionId: presence.sessionId,
          name: presence.name,
        });
      }
    });

  return [...participants.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "es", {
      sensitivity: "base",
    })
  );
}

function App() {
  const [nameInput, setNameInput] = useState("");
  const [joined, setJoined] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState("disconnected");

  const channelRef = useRef(null);
  const heartbeatRef = useRef(null);
  const sessionIdRef = useRef(null);

  async function leaveLobby() {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }

    const channel = channelRef.current;
    channelRef.current = null;

    if (channel) {
      await channel.untrack();
      await supabase.removeChannel(channel);
    }

    if (sessionIdRef.current) {
      await supabase.rpc("release_lobby_name", {
        p_session_id: sessionIdRef.current,
      });
    }

    setJoined(null);
    setUsers([]);
    setConnection("disconnected");
  }

  async function joinLobby(event) {
    event.preventDefault();
    setError("");

    const name = nameInput.trim();

    if (!/^[A-Za-z0-9_-]{3,20}$/.test(name)) {
      setError(
        "Usa entre 3 y 20 caracteres: letras sin tildes, números, guion o guion bajo."
      );
      return;
    }

    setBusy(true);

    try {
      if (!sessionIdRef.current) {
        sessionIdRef.current = getSessionId();
      }

      const sessionId = sessionIdRef.current;

      const { data: claimed, error: claimError } =
        await supabase.rpc("claim_lobby_name", {
          p_name: name,
          p_session_id: sessionId,
        });

      if (claimError) {
        throw claimError;
      }

      if (!claimed) {
        setError(
          "Ese nombre ya está ocupado. Prueba con otro."
        );
        return;
      }

      const channel = supabase.channel("global-lobby", {
        config: {
          presence: {
            key: sessionId,
          },
        },
      });

      channel.on(
        "presence",
        { event: "sync" },
        () => setUsers(readPresence(channel))
      );

      channelRef.current = channel;
      setConnection("connecting");

      const subscriptionStatus = await new Promise((resolve) => {
        channel.subscribe((status) => {
          if (
            status === "SUBSCRIBED" ||
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            resolve(status);
          }
        });
      });

      if (subscriptionStatus !== "SUBSCRIBED") {
        throw new Error(
          "No pudimos conectar con la sala. Inténtalo de nuevo."
        );
      }

      const trackResult = await channel.track({
        name,
        sessionId,
        joinedAt: new Date().toISOString(),
      });

      if (trackResult.status !== "ok") {
        throw new Error(
          "No pudimos publicar tu presencia en la sala."
        );
      }

      setJoined({ name, sessionId });
      setConnection("connected");

      heartbeatRef.current = window.setInterval(
        async () => {
          const { data, error: renewError } =
            await supabase.rpc("renew_lobby_name", {
              p_name: name,
              p_session_id: sessionId,
            });

          if (renewError || !data) {
            setError(
              "Tu reserva de nombre se perdió. Vuelve a entrar."
            );
            await leaveLobby();
          }
        },
        30_000
      );
    } catch (err) {
      const channel = channelRef.current;
      channelRef.current = null;

      if (channel) {
        await supabase.removeChannel(channel);
      }

      if (sessionIdRef.current) {
        await supabase.rpc("release_lobby_name", {
          p_session_id: sessionIdRef.current,
        });
      }

      setConnection("disconnected");
      setError(
        err.message || "Ocurrió un error al entrar a la sala."
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
      }

      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current);
      }

      if (sessionIdRef.current) {
        void supabase.rpc("release_lobby_name", {
          p_session_id: sessionIdRef.current,
        });
      }
    };
  }, []);

  return (
    <main className="page">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-icon">L</span>
          <span>LOBBY</span>
        </a>

        <span className="global-tag">
          <span className="live-dot" />
          SALA GLOBAL
        </span>
      </header>

      {!joined ? (
        <section className="join-card">
          <div className="eyebrow">UN LUGAR PARA TODOS</div>

          <h1>Entra en la sala.</h1>

          <p className="subtitle">
            Elige tu nombre y descubre quién más está conectado.
          </p>

          <form onSubmit={joinLobby}>
            <label htmlFor="username">Tu nombre de usuario</label>

            <input
              id="username"
              type="text"
              value={nameInput}
              onChange={(event) =>
                setNameInput(event.target.value)
              }
              placeholder="Ej. PixelGhost"
              minLength={3}
              maxLength={20}
              autoComplete="nickname"
              autoFocus
              disabled={busy}
            />

            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}

            <button type="submit" disabled={busy}>
              {busy ? "Conectando..." : "Entrar a la sala"}
            </button>
          </form>

          <p className="privacy-note">
            Sin registro. Solo necesitas un nombre único.
          </p>
        </section>
      ) : (
        <section className="lobby">
          <div className="lobby-heading">
            <div>
              <div className="eyebrow">SALA GENERAL</div>
              <h1>¿Quién está aquí?</h1>
              <p className="subtitle">
                Estás dentro como{" "}
                <strong>{joined.name}</strong>.
              </p>
            </div>

            <div className="online-counter">
              <span className="live-dot" />
              <strong>{users.length}</strong>
              <span>
                {users.length === 1 ? "persona" : "personas"}
              </span>
            </div>
          </div>

          <div className="participant-grid">
            {users.map((user) => (
              <article
                className="participant"
                key={user.sessionId}
              >
                <div className="avatar">
                  {user.name.charAt(0).toUpperCase()}
                </div>

                <span className="participant-name">
                  {user.name}
                </span>

                {user.sessionId === joined.sessionId && (
                  <span className="you-label">TÚ</span>
                )}
              </article>
            ))}
          </div>

          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}

          <div className="lobby-footer">
            <span className="connection-label">
              <span
                className={
                  connection === "connected"
                    ? "live-dot"
                    : "warning-dot"
                }
              />
              {connection === "connected"
                ? "Conectado en tiempo real"
                : "Reconectando..."}
            </span>

            <button
              className="leave-button"
              onClick={leaveLobby}
            >
              Salir de la sala
            </button>
          </div>
        </section>
      )}

      <footer className="page-footer">
        UNA SALA · MUCHAS PERSONAS
      </footer>
    </main>
  );
}

export default App;
