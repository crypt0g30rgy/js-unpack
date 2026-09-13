// restore-sourcemaps: reconstruct original source files from JavaScript
// source map (.map) files.
//
// Install:
//   go install github.com/crypt0g30rgy/js-unpack/cmd/restore-sourcemap@latest
//
// Usage:
//   restore-sourcemap <input.map|dir|glob> <output-dir> [--flat] [--verbose] [--dry-run] [--recursive]
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// ---- source map shape ----

type sourceMap struct {
	Sources        []string `json:"sources"`
	SourcesContent []string `json:"sourcesContent"`
	SourceRoot     string   `json:"sourceRoot"`
}

// ---- options ----

type options struct {
	flat      bool
	verbose   bool
	dryRun    bool
	recursive bool
}

// ---- per-file stats ----

type fileStats struct {
	restored         int
	skippedNoContent int
	errors           int
	valid            bool
}

// ---- totals ----

type totals struct {
	files        int
	validFiles   int
	invalidFiles int
	restored     int
	skippedNo    int
	errors       int
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: restore-sourcemap <input.map|dir|glob> <output-dir> [--flat] [--verbose] [--dry-run] [--recursive]")
	fmt.Fprintln(os.Stderr, "  <input.map|dir|glob> can be:")
	fmt.Fprintln(os.Stderr, "    - a single .map file")
	fmt.Fprintln(os.Stderr, "    - a directory (all *.map files in it are processed)")
	fmt.Fprintln(os.Stderr, "    - a glob like \"./maps/*.map\" (simple * and ? wildcards only)")
	os.Exit(1)
}

func main() {
	var input, outDir string
	opts := options{}

	args := os.Args[1:]
	for _, a := range args {
		switch a {
		case "--flat":
			opts.flat = true
		case "--verbose":
			opts.verbose = true
		case "--dry-run":
			opts.dryRun = true
		case "--recursive":
			opts.recursive = true
		default:
			if input == "" {
				input = a
			} else if outDir == "" {
				outDir = a
			} else {
				fmt.Fprintln(os.Stderr, "Unknown arg:", a)
				usage()
			}
		}
	}
	if input == "" || outDir == "" {
		usage()
	}

	outRoot, err := filepath.Abs(outDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "❌ Cannot resolve output dir:", err)
		os.Exit(1)
	}

	mapFiles := resolveInputFiles(input, opts.recursive)
	if len(mapFiles) == 0 {
		fmt.Fprintln(os.Stderr, "No .map files found for input:", input)
		os.Exit(2)
	}

	if opts.verbose || len(mapFiles) > 1 {
		fmt.Printf("Found %d map file(s) to process.\n", len(mapFiles))
	}

	var t totals
	for _, mf := range mapFiles {
		t.files++
		stats := processMapFile(mf, outRoot, opts)
		if !stats.valid {
			t.invalidFiles++
			continue
		}
		t.validFiles++
		t.restored += stats.restored
		t.skippedNo += stats.skippedNoContent
		t.errors += stats.errors
	}

	fmt.Printf("\nSummary: files=%d, valid=%d, invalid=%d, restored=%d, skippedNoContent=%d, errors=%d\n",
		t.files, t.validFiles, t.invalidFiles, t.restored, t.skippedNo, t.errors)
	if opts.dryRun {
		fmt.Println("Note: dry-run mode, no files were written.")
	}
	if t.invalidFiles > 0 {
		os.Exit(5)
	}
}

// ---- path sanitization ----

var (
	reWebpackInternal = regexp.MustCompile(`^webpack-internal:/+`)
	reWebpack         = regexp.MustCompile(`^webpack:/+`)
	reFile            = regexp.MustCompile(`^file:/+`)
	reLeadingSlashes  = regexp.MustCompile(`^/+`)
	reLeadingBangs    = regexp.MustCompile(`^!+`)
	reLeadingDotSlash = regexp.MustCompile(`^\./`)
)

func sanitizeSourcePath(src, sourceRoot string) string {
	if src == "" {
		return ""
	}

	src = reWebpackInternal.ReplaceAllString(src, "")
	src = reWebpack.ReplaceAllString(src, "")
	src = reFile.ReplaceAllString(src, "")
	src = reLeadingSlashes.ReplaceAllString(src, "")

	// drop loader/inline prefixes (e.g. "!!./file.js")
	src = reLeadingBangs.ReplaceAllString(src, "")

	// drop surrounding ./ if present
	src = reLeadingDotSlash.ReplaceAllString(src, "")

	// drop query/hash
	src = strings.SplitN(src, "?", 2)[0]
	src = strings.SplitN(src, "#", 2)[0]

	// if there's a sourceRoot, prepend it (posix join, normalize later)
	if sourceRoot != "" {
		src = path.Join(sourceRoot, src)
	}

	// normalize to OS-specific separators
	src = strings.ReplaceAll(src, "/", string(filepath.Separator))

	// remove any leading ../ segments so it cannot escape the output dir
	upPrefix := ".." + string(filepath.Separator)
	for strings.Index(src, upPrefix) == 0 {
		src = src[len(upPrefix):]
	}

	return src
}

// ---- input resolution (file / directory / simple glob) ----

func isGlob(s string) bool {
	return strings.ContainsAny(s, "*?")
}

func globToRegexp(glob string) *regexp.Regexp {
	specialChars := regexp.MustCompile(`[.+^${}()|\[\]\\]`)
	escaped := specialChars.ReplaceAllStringFunc(glob, func(m string) string {
		return "\\" + m
	})
	escaped = strings.ReplaceAll(escaped, "*", ".*")
	escaped = strings.ReplaceAll(escaped, "?", ".")
	return regexp.MustCompile("^" + escaped + "$")
}

func hasMapExt(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), ".map")
}

func walkDir(dir string, recurse bool, acc []string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ Cannot read directory %s: %s\n", dir, err)
		return acc
	}
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if recurse {
				acc = walkDir(full, recurse, acc)
			}
		} else if hasMapExt(entry.Name()) {
			acc = append(acc, full)
		}
	}
	return acc
}

func matchDir(dir string, regex *regexp.Regexp, recurse bool, acc []string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ Cannot read directory %s: %s\n", dir, err)
		return acc
	}
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if recurse {
				acc = matchDir(full, regex, recurse, acc)
			}
		} else if regex.MatchString(entry.Name()) {
			acc = append(acc, full)
		}
	}
	return acc
}

func resolveInputFiles(inputArg string, recurse bool) []string {
	if info, err := os.Stat(inputArg); err == nil && info.IsDir() {
		return walkDir(inputArg, recurse, []string{})
	}

	if isGlob(inputArg) {
		dir := filepath.Dir(inputArg)
		pattern := filepath.Base(inputArg)
		baseDir := dir
		if baseDir == "" {
			baseDir = "."
		}

		info, err := os.Stat(baseDir)
		if err != nil || !info.IsDir() {
			fmt.Fprintln(os.Stderr, "Glob base directory not found:", baseDir)
			return []string{}
		}

		regex := globToRegexp(pattern)
		return matchDir(baseDir, regex, recurse, []string{})
	}

	if _, err := os.Stat(inputArg); err != nil {
		fmt.Fprintln(os.Stderr, "Input file not found:", inputArg)
		return []string{}
	}
	return []string{inputArg}
}

// ---- processing a single .map file ----

func processMapFile(mapFile, outRoot string, opts options) fileStats {
	stats := fileStats{valid: true}

	raw, err := os.ReadFile(mapFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ [%s] Failed to read source map: %s\n", mapFile, err)
		stats.valid = false
		stats.errors++
		return stats
	}

	var sm sourceMap
	if err := json.Unmarshal(raw, &sm); err != nil {
		fmt.Fprintf(os.Stderr, "❌ [%s] Failed to parse source map: %s\n", mapFile, err)
		stats.valid = false
		stats.errors++
		return stats
	}

	if sm.Sources == nil {
		fmt.Fprintf(os.Stderr, "❌ [%s] Invalid source map: missing \"sources\" array.\n", mapFile)
		stats.valid = false
		stats.errors++
		return stats
	}

	if !opts.dryRun {
		if err := os.MkdirAll(outRoot, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "❌ [%s] Failed to create output dir %s: %s\n", mapFile, outRoot, err)
			stats.errors++
		}
	}

	for i, srcPath := range sm.Sources {
		var content string
		hasContent := false
		if i < len(sm.SourcesContent) {
			// Note: unlike JS, Go's encoding/json can't tell us whether the
			// JSON value was `null` vs an empty string once unmarshaled into
			// a plain string slice, so an explicit null and "" are treated
			// the same (no content) — matching the practical behavior of
			// the original tool for real-world source maps.
			content = sm.SourcesContent[i]
			hasContent = content != ""
		}

		cleanRel := sanitizeSourcePath(srcPath, sm.SourceRoot)
		if cleanRel == "" {
			if opts.verbose {
				fmt.Fprintf(os.Stderr, "[skip] [%s] empty/unsalvageable source path at index %d: %q\n", mapFile, i, srcPath)
			}
			continue
		}

		destPath := filepath.Join(outRoot, cleanRel)
		absDest, err := filepath.Abs(destPath)
		if err != nil {
			absDest = destPath
		}
		if absDest != outRoot && !strings.HasPrefix(absDest, outRoot+string(filepath.Separator)) {
			// sanitize by using only the basename
			absDest = filepath.Join(outRoot, filepath.Base(cleanRel))
		}
		destPath = absDest

		if opts.flat {
			destPath = filepath.Join(outRoot, filepath.Base(destPath))
		}

		if opts.verbose {
			fmt.Printf("[info] [%s] source[%d] -> %s\n", mapFile, i, destPath)
		}

		if !hasContent {
			stats.skippedNoContent++
			if opts.verbose {
				fmt.Fprintf(os.Stderr, "[skip] [%s] no sourcesContent for %q\n", mapFile, srcPath)
			}
			continue
		}

		dir := filepath.Dir(destPath)
		if !opts.dryRun {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				stats.errors++
				fmt.Fprintf(os.Stderr, "❌ [%s] Failed to write %s: %s\n", mapFile, destPath, err)
				continue
			}
			if err := os.WriteFile(destPath, []byte(content), 0o644); err != nil {
				stats.errors++
				fmt.Fprintf(os.Stderr, "❌ [%s] Failed to write %s: %s\n", mapFile, destPath, err)
				continue
			}
		}
		stats.restored++
		fmt.Printf("✅ [%s] Restored: %s\n", mapFile, destPath)
	}

	return stats
}