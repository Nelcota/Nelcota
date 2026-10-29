import type { Node, MaybeNamedFunctionDeclaration, MaybeNamedClassDeclaration } from "estree";

/** Default-exported declarations can be anonymous while sharing the same visitor kind. */
export type RuleNode = Node | MaybeNamedFunctionDeclaration | MaybeNamedClassDeclaration;

/** The ESTree fields consumed by these portable Oxlint rules. */
export interface RuleContext {
  readonly filename: string;
  readonly cwd: string;
  report(diagnostic: { node: RuleNode; message: string }): void;
}

/** Each visitor receives the node selected by its ESTree kind. */
type Visitors = { [Kind in RuleNode["type"]]?: (node: Extract<RuleNode, { type: Kind }>) => void };

/** Shared contract for the local, stateless rule plugins. */
export interface RulePlugin {
  meta: { name: string };
  rules: Record<string, { create(context: RuleContext): Visitors }>;
}
