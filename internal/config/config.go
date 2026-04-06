package config

import (
	"flag"
	"os"
	"strings"
)

// Config holds the server configuration.
type Config struct {
	Addr           string   // Listen address, e.g. "127.0.0.1:8080"
	DBPath         string   // SQLite database file path
	AllowedOrigins []string // CORS allowed origins
	Version        string   // Server version (injected at build time)
}

// Parse reads configuration from command-line flags and environment variables.
// Environment variables override flags.
func Parse(version string) *Config {
	cfg := &Config{Version: version}

	flag.StringVar(&cfg.Addr, "addr", "127.0.0.1:9001", "Listen address")
	flag.StringVar(&cfg.DBPath, "db", "./data/blog-helper.db", "SQLite database path")

	var origins string
	flag.StringVar(&origins, "allowed-origins", "https://your-site.com", "Comma-separated CORS allowed origins")

	flag.Parse()

	// Environment variables override flags
	if v := os.Getenv("BH_ADDR"); v != "" {
		cfg.Addr = v
	}
	if v := os.Getenv("BH_DB"); v != "" {
		cfg.DBPath = v
	}
	if v := os.Getenv("BH_ALLOWED_ORIGINS"); v != "" {
		origins = v
	}

	cfg.AllowedOrigins = parseOrigins(origins)
	return cfg
}

func parseOrigins(s string) []string {
	parts := strings.Split(s, ",")
	origins := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			origins = append(origins, p)
		}
	}
	return origins
}
