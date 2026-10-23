import { Kind, type DocumentNode, type FragmentDefinitionNode } from 'graphql';

export interface ValidationResult {
  cost: number;
  depth: number;
  fragments: Map<string, FragmentDefinitionNode>;
}

const cache = new WeakMap<DocumentNode, ValidationResult>();

export function getValidationResult(doc: DocumentNode): ValidationResult | undefined {
  return cache.get(doc);
}

export function setValidationResult(doc: DocumentNode, result: ValidationResult): void {
  cache.set(doc, result);
}

export function buildFragmentMap(doc: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  return fragments;
}
