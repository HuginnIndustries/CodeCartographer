# CodeCartographer Website

This folder is a static website bundle for `codecarto.dev`.

## Files

- `index.html` - homepage
- `styles.css` - site styling
- `script.js` - small interactive behaviors
- `robots.txt` - crawler guidance
- `sitemap.xml` - sitemap for the live domain
- `.htaccess` - optional Apache defaults for cPanel hosting

## Deploy To Namecheap cPanel

1. Open Namecheap cPanel for the account serving `codecarto.dev`.
2. Go to `File Manager`.
3. Open the document root for the domain:
   - primary domain: usually `public_html/`
   - addon domain: the folder assigned as that domain's document root
4. Upload the contents of this `website/` folder into that document root.
5. Confirm `index.html` is at the top of the document root, not nested inside another folder.
6. Visit `https://codecarto.dev/` and hard refresh.

## Important Link Notes

The homepage currently points to:

- repository: `https://github.com/HuginnIndustries/CodeCartographer`
- ZIP archive: `https://github.com/HuginnIndustries/CodeCartographer/archive/refs/heads/Dev.zip`

If the default distribution branch changes from `Dev` to `main`, update the ZIP links in `index.html`.

## Recommended cPanel Settings

- Enable AutoSSL for `codecarto.dev`
- Force HTTPS in the domain settings or with the `.htaccess` file here
- Replace any older placeholder `index.*` file so Apache serves this homepage first
