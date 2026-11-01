/**
 * Browser translators (Google Translate, Edge, Safari) replace text nodes with their own `<font>` elements behind
 * React's back. When React later removes or moves one of the nodes it rendered, the node is no longer where React
 * left it and the DOM throws `NotFoundError` from removeChild or insertBefore, which unmounts the whole app. This is
 * the long-standing workaround from facebook/react#11538: skip the call instead of throwing. React's own updates
 * are unaffected, because for them the nodes are always where React put them.
 *
 * It hides the crash, not the cause. Text React updates behind a translation can stay frozen, and a node that was
 * swapped rather than removed can leave the old translated text next to the new one. Live parts (the dashboard
 * canvas, the landing page's demo, the editor's save status) are therefore marked `translate="no"`.
 */
const GUARDED = Symbol.for('patchbay.translatorGuard');

// Silent in production, where it would only be noise; in development a swallowed call may be a real bug of ours.
const warn = (method: string, node: Node, parent: Node) => {
  if (import.meta.env.DEV)
    console.warn(`translator guard: skipped ${method}, the node is not a child of this parent`, node, parent);
};

export function guardAgainstTranslators(proto: Node = Node.prototype) {
  const target = proto as Node & { [GUARDED]?: true };
  if (target[GUARDED]) return;
  target[GUARDED] = true;
  const removeChild = proto.removeChild;
  const insertBefore = proto.insertBefore;
  proto.removeChild = function guardedRemoveChild<T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) {
      warn('removeChild', child, this);
      return child;
    }
    return removeChild.call(this, child) as T;
  };
  proto.insertBefore = function guardedInsertBefore<T extends Node>(
    this: Node,
    node: T,
    child: Node | null,
  ): T {
    if (child && child.parentNode !== this) {
      warn('insertBefore', child, this);
      return node;
    }
    return insertBefore.call(this, node, child) as T;
  };
}
