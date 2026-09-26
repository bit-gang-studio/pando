import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Doctor = { git_version: string | null; git_ok: boolean; min_git: string };

export default function App() {
  const [version, setVersion] = useState("");
  const [doctor, setDoctor] = useState<Doctor | null>(null);

  useEffect(() => {
    invoke<string>("version").then(setVersion);
    invoke<Doctor>("doctor").then(setDoctor);
  }, []);

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-semibold">Pando</h1>
      <p className="text-sm opacity-70">v{version || "…"}</p>
      {doctor && (
        <p className="text-sm">
          git {doctor.git_version ?? "not found"}{" "}
          {doctor.git_ok ? "ok" : `(need ${doctor.min_git}+)`}
        </p>
      )}
    </main>
  );
}
