import matter from 'gray-matter';
import { slugifyPath } from './sync.ts';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  compiled_truth: string;
  slug: string;
  types: string[];
  title: string;
  tags: string[];
}

/**
 * Parse a markdown file with YAML frontmatter into its components.
 *
 * Structure:
 *   ---
 *   types: [concept, framework]
 *   title: Do Things That Don't Scale
 *   tags: [startups, growth]
 *   ---
 *   Compiled truth content here...
 *
 * The first --- pair is YAML frontmatter (handled by gray-matter).
 * After frontmatter, the entire body is compiled_truth.
 *
 * Backward compat: singular `type:` in frontmatter is converted to `types: [type]`.
 */
export function parseMarkdown(content: string, filePath?: string): ParsedMarkdown {
  const { data: frontmatter, content: body } = matter(content);

  const compiled_truth = body.trim();

  // Extract types — support both `types:` (array) and `type:` (singular, backward compat)
  let types: string[];
  if (frontmatter.types) {
    types = Array.isArray(frontmatter.types)
      ? frontmatter.types.map(String)
      : [String(frontmatter.types)];
  } else if (frontmatter.type) {
    types = [String(frontmatter.type)];
  } else {
    types = inferTypes(filePath);
  }

  const title = (frontmatter.title as string) || inferTitle(filePath);
  const tags = extractTags(frontmatter);
  const slug = (frontmatter.slug as string) || inferSlug(filePath);

  // Remove processed fields from frontmatter (they're stored as columns)
  const cleanFrontmatter = { ...frontmatter };
  delete cleanFrontmatter.types;
  delete cleanFrontmatter.type;
  delete cleanFrontmatter.title;
  delete cleanFrontmatter.tags;
  delete cleanFrontmatter.slug;

  return {
    frontmatter: cleanFrontmatter,
    compiled_truth,
    slug,
    types,
    title,
    tags,
  };
}

/**
 * Serialize a page back to markdown format.
 * Produces: frontmatter + compiled_truth
 */
export function serializeMarkdown(
  frontmatter: Record<string, unknown>,
  compiled_truth: string,
  meta: { types: string[]; title: string; tags: string[] },
): string {
  // Build full frontmatter including types, title, tags
  const fullFrontmatter: Record<string, unknown> = {
    types: meta.types,
    title: meta.title,
    ...frontmatter,
  };
  if (meta.tags.length > 0) {
    fullFrontmatter.tags = meta.tags;
  }

  const yamlContent = matter.stringify('', fullFrontmatter).trim();

  return yamlContent + '\n\n' + compiled_truth + '\n';
}

export function inferTypes(filePath?: string): string[] {
  if (!filePath) return ['concept'];

  // Normalize: add leading / for consistent matching
  const lower = ('/' + filePath).toLowerCase();
  if (lower.includes('/people/') || lower.includes('/person/')) return ['person'];
  if (lower.includes('/companies/') || lower.includes('/company/')) return ['company'];
  if (lower.includes('/deals/') || lower.includes('/deal/')) return ['deal'];
  if (lower.includes('/projects/') || lower.includes('/project/')) return ['project'];
  if (lower.includes('/meetings/') || lower.includes('/meeting/')) return ['meeting'];
  if (lower.includes('/decisions/') || lower.includes('/decision/')) return ['decision'];
  if (lower.includes('/intel/')) return ['intel'];
  if (lower.includes('/notes/') || lower.includes('/note/')) return ['note'];
  if (lower.includes('/concepts/') || lower.includes('/concept/')) return ['concept'];
  if (lower.includes('/sources/') || lower.includes('/source/')) return ['source'];
  if (lower.includes('/media/')) return ['media'];
  return ['concept'];
}

function inferTitle(filePath?: string): string {
  if (!filePath) return 'Untitled';

  // Extract filename without extension, convert dashes/underscores to spaces
  const parts = filePath.split('/');
  const filename = parts[parts.length - 1]?.replace(/\.md$/i, '') || 'Untitled';
  return filename.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function inferSlug(filePath?: string): string {
  if (!filePath) return 'untitled';
  return slugifyPath(filePath);
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags;
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}
