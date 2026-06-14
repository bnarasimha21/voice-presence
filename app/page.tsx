import Link from "next/link";
import { personas } from "@/lib/personas";

export default function Home() {
  const personaList = Object.values(personas);

  return (
    <main className="min-h-screen bg-neutral-950 text-white flex flex-col items-center justify-center gap-12 p-8">
      <div className="text-center space-y-3">
        <h1 className="text-4xl font-bold tracking-tight">Someone to talk to</h1>
        <p className="text-neutral-400 max-w-sm">
          Real conversations with real people — powered by AI, in their actual voice.
        </p>
      </div>

      <div className="flex flex-col gap-4 w-full max-w-sm">
        {personaList.map((persona) => (
          <Link
            key={persona.id}
            href={`/talk?persona=${persona.id}`}
            className="flex items-center gap-4 bg-neutral-900 hover:bg-neutral-800 rounded-2xl p-4 transition-colors"
          >
            <div className="w-14 h-14 rounded-full bg-neutral-700 overflow-hidden flex-shrink-0">
              <img
                src={persona.avatarUrl}
                alt={persona.name}
                className="w-full h-full object-cover"
              />
            </div>
            <div>
              <p className="font-semibold">{persona.name}</p>
              <p className="text-sm text-neutral-400">{persona.tagline}</p>
            </div>
            <span className="ml-auto text-neutral-600">→</span>
          </Link>
        ))}

        {/* V2 placeholder — Abhi */}
        <div className="flex items-center gap-4 bg-neutral-900/40 rounded-2xl p-4 opacity-40 cursor-not-allowed select-none">
          <div className="w-14 h-14 rounded-full bg-neutral-800 flex-shrink-0" />
          <div>
            <p className="font-semibold">Abhi</p>
            <p className="text-sm text-neutral-500">Coming soon</p>
          </div>
        </div>
      </div>
    </main>
  );
}
