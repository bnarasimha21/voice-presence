import { narsiPersona } from "./narsi";

export const personas = {
  narsi: narsiPersona,
  // abhi: abhiPersona,  // V2
};

export type PersonaId = keyof typeof personas;
export type Persona = (typeof personas)[PersonaId];
