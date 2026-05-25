# Migration Pack: Formix — Design Subscription Landing Page

**Source:** https://willing-graphs-650959.framer.app
**Pages:** 7
**Generated:** 2026-05-25

## Page Types
- landing: 7 pages

## Directory Structure

```
migration/
  README.md              ← You are here
  migration-manifest.json ← Machine-readable site map
  content/               ← Markdown content per page
  seo/                   ← SEO metadata + JSON-LD schemas
  fonts.css              ← @font-face declarations
  design-tokens.json     ← Colors, fonts, spacing
  robots.txt             ← AI-crawler-friendly robots.txt
  llms.txt               ← Machine-readable site description
  sitemap.xml            ← XML sitemap
  redirects.json         ← URL redirect map
```

## How to Use This Pack

### With AI Coding Tools (Claude, Cursor, Windsurf)
Give this folder to your AI tool and say:

> "Rebuild this site in [Astro/Next.js/Hugo]. Use the markdown content from `content/`, the SEO metadata from `seo/`, and the design tokens from `design-tokens.json`. The JSON-LD schemas in `seo/schema/` should be included on each page. Font declarations are in `fonts.css`. See `migration-manifest.json` for the full site map."

### With Astro
```bash
npm create astro@latest my-site
# Copy content/*.md → src/content/
# Copy seo/ → use in frontmatter
# Copy fonts.css → src/styles/fonts.css
```

### With Next.js
```bash
npx create-next-app my-site
# Copy content/*.md → use with next-mdx-remote or contentlayer
# Copy seo/ → use in generateMetadata()
```

### With Hugo
```bash
hugo new site my-site
# Copy content/*.md → content/
# Hugo reads frontmatter natively
```

## Notes

- Content is extracted using Mozilla Readability. Quality varies by page structure.
- JSON-LD schemas include confidence scores. Review schemas with confidence < 0.7 before deploying.
- The `llms.txt` "What We Do Not Do" section is a placeholder — fill it in to prevent AI hallucination.
- Font CSS uses root-relative paths (`/fonts/...`). Adjust paths for your project.
