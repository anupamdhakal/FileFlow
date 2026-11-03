# Changelog

## [1.0.0] — 2026-11-03

First public-release candidate of FileFlow.

### Added

- Image conversion and compression using ImageMagick for PNG, JPEG, WebP, and AVIF.
- Audio conversion to MP3, WAV, and FLAC and video conversion to MP4, WebM, and MOV using FFmpeg.
- PDF page rendering to PNG or JPG with individual previews and downloads.
- Multi-file conversion queue with per-file progress, cancellation, error states, individual downloads, and ZIP downloads.
- Image size comparison, presets, approximate output estimates, metadata previews, conversion history, keyboard shortcuts, and light/dark themes.
- Installable PWA shell with static-asset caching that bypasses uploads and conversion results.
- Production API validation, rate limits, concurrency limits, conversion timeouts, output and page-count limits, safe errors, security headers, and temporary-file cleanup.

### Release notes

- Conversion support depends on the codecs available in the host’s FFmpeg and ImageMagick builds.
- Browser history stores metadata only; downloads are available only while results remain in the current page session.
- Public deployment requires HTTPS, a trusted reverse proxy, resource limits, and an explicit project license before open-source publication.
