import { describe, expect, it } from 'vitest';
import { guardAgainstTranslators } from './translator-guard.ts';

/**
 * The web tests run in Node without a DOM, so a minimal node stands in for Node.prototype: it throws like the DOM
 * when the child or the reference node belongs to another parent.
 */
class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  removeChild(child: FakeNode): FakeNode {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error('NotFoundError: not a child of this node');
    this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    if (i < 0) throw new Error('NotFoundError: reference is not a child of this node');
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
}

class GuardedNode extends FakeNode {}
guardAgainstTranslators(GuardedNode.prototype as unknown as Node);

const tree = () => {
  const parent = new GuardedNode();
  const child = new GuardedNode();
  parent.insertBefore(child, null);
  return { parent, child };
};

describe('guardAgainstTranslators', () => {
  it('still removes and inserts real children', () => {
    const { parent, child } = tree();
    const other = new GuardedNode();
    expect(parent.insertBefore(other, child)).toBe(other);
    expect(parent.children).toEqual([other, child]);
    expect(parent.removeChild(child)).toBe(child);
    expect(parent.children).toEqual([other]);
  });

  it('skips removing a node a translator already moved elsewhere', () => {
    const { parent, child } = tree();
    const translatorFont = new GuardedNode();
    translatorFont.insertBefore(parent.removeChild(child), null);
    expect(() => parent.removeChild(child)).not.toThrow();
    expect(parent.removeChild(child)).toBe(child);
    expect(translatorFont.children).toEqual([child]);
  });

  it('skips inserting before a reference node that is no longer a child', () => {
    const { parent, child } = tree();
    const elsewhere = new GuardedNode();
    elsewhere.insertBefore(parent.removeChild(child), null);
    const node = new GuardedNode();
    expect(() => parent.insertBefore(node, child)).not.toThrow();
    expect(parent.children).toEqual([]);
  });

  it('patches a prototype only once', () => {
    const before = GuardedNode.prototype.removeChild;
    guardAgainstTranslators(GuardedNode.prototype as unknown as Node);
    expect(GuardedNode.prototype.removeChild).toBe(before);
  });

  it('leaves an unguarded prototype throwing', () => {
    const parent = new FakeNode();
    expect(() => parent.removeChild(new FakeNode())).toThrow(/NotFoundError/);
  });
});
