# SellerSignal Deployment Guide

## Files Included

```
sellersignal-deploy/
├── server.js           # Backend API server
├── package.json        # Dependencies
└── public/
    ├── index.html      # Landing/marketing page (homepage)
    └── app.html        # Main app (search interface)
```

## Quick Deploy to Railway

Since you already have the Railway project connected:

### Replace Files in Your Existing Repo

1. In your local `prospectiq-backend` folder:
   - Replace `server.js` with the new `server.js`
   - Delete old `public/index.html`
   - Add new `public/index.html` (landing page)
   - Add `public/app.html` (the app)

2. In GitHub Desktop:
   - Commit: "Rebrand to SellerSignal"
   - Push to GitHub

3. Railway auto-deploys in ~1-2 minutes

## After Deployment

Your URLs will be:
- **Homepage:** https://sellersignal.co (landing page)
- **App:** https://sellersignal.co/app.html

## What's New in This Version

- ✅ SellerSignal branding (logo, name, colors)
- ✅ Landing page with pricing, features, how-it-works
- ✅ Server updated with SellerSignal branding
- ✅ Temperature=0 for consistent results
- ✅ 6-hour caching system
- ✅ Retry logic for rate limiting

## Environment Variables (Already Set in Railway)

- `ANTHROPIC_API_KEY` - Your Anthropic API key
- `PORT` - Auto-set by Railway

## Next Steps After Deploy

1. Test the landing page at sellersignal.co
2. Test the app at sellersignal.co/app.html
3. Set up Stripe for billing
4. Add search limits per pricing tier
