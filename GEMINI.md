# Project Workflow & Instructions

## Workflow: Stage & Review
For all functional or stylistic changes:
1.  **Implementation**: Apply changes to the local workspace files.
2.  **Validation**:
    - Run relevant local scripts (e.g., `npm run prerender`, `npm run fetch:news`) to verify the build.
    - Start a local webserver (e.g., `npx serve .`).
3.  **Human Review**:
    - Prompt the user to open the local site in a browser (e.g., Chrome) to visually verify changes.
    - Present a detailed summary and diff of the changes to the user.
4.  **Approval**: Wait for explicit user approval.
5.  **Deployment**: Only after approval, perform `git commit` and `git push`.

## Tech Stack & Standards
- **Styling**: Vanilla CSS (no Tailwind).
- **Automation**: GitHub Actions for daily news fetching and pre-rendering.
- **Images**: Prefer optimized JPEGs/AVIFs; use `loading="lazy"` and explicit dimensions.
- **SEO**: Automated `sitemap.xml` and `robots.txt` generation.
