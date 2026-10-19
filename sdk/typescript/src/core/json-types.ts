/** Shared JSON wire values; independent of feature modules. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
