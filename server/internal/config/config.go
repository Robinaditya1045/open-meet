// Package config reads the server's settings from the environment.
package config

import (
	"bufio"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Robinaditya1045/open-meet/server/internal/meeting"
)

// Config is every setting the server reads.
type Config struct {
	HTTPAddr string

	RTCUDPPort        int
	RTCTCPPort        int
	PublicIPs         []string
	IPv6              bool
	ExcludeInterfaces []string

	// ICEServers are handed to browsers, not used by the SFU itself.
	ICEServers []meeting.ICEServer

	AllowedOrigins []string
	TrustProxy     bool

	DataDir string
	WebDir  string

	MaxParticipants int
	ReconnectGrace  time.Duration
	// MeetingTTL forgets meeting links nobody has used for this long.
	MeetingTTL time.Duration

	LogLevel slog.Level
}

// Load reads the environment, after first loading a .env file from the working
// directory if there is one. Variables already set win over the file.
func Load() (Config, error) {
	loadDotEnv(".env")

	c := Config{
		HTTPAddr:          env("MEET_HTTP_ADDR", ":8088"),
		PublicIPs:         list(env("MEET_PUBLIC_IP", "")),
		ExcludeInterfaces: list(env("MEET_RTC_EXCLUDE_INTERFACES", "docker,br-,veth,virbr,lxc,tailscale")),
		AllowedOrigins:    list(env("MEET_ALLOWED_ORIGINS", "http://localhost:5188,http://127.0.0.1:5188")),
		DataDir:           env("MEET_DATA_DIR", "./data"),
		WebDir:            env("MEET_WEB_DIR", ""),
	}

	var err error
	if c.RTCUDPPort, err = intEnv("MEET_RTC_UDP_PORT", 7882); err != nil {
		return c, err
	}
	if c.RTCTCPPort, err = intEnv("MEET_RTC_TCP_PORT", 7881); err != nil {
		return c, err
	}
	if c.MaxParticipants, err = intEnv("MEET_MAX_PARTICIPANTS", 50); err != nil {
		return c, err
	}
	if c.IPv6, err = boolEnv("MEET_RTC_IPV6", false); err != nil {
		return c, err
	}
	if c.TrustProxy, err = boolEnv("MEET_TRUST_PROXY", false); err != nil {
		return c, err
	}
	if c.ReconnectGrace, err = durationEnv("MEET_RECONNECT_GRACE", 20*time.Second); err != nil {
		return c, err
	}
	if c.MeetingTTL, err = durationEnv("MEET_MEETING_TTL", 90*24*time.Hour); err != nil {
		return c, err
	}
	if err := c.LogLevel.UnmarshalText([]byte(env("MEET_LOG_LEVEL", "info"))); err != nil {
		return c, fmt.Errorf("MEET_LOG_LEVEL: %w", err)
	}

	c.ICEServers = iceServers(
		list(env("MEET_ICE_SERVERS", "")),
		env("MEET_TURN_USERNAME", ""),
		env("MEET_TURN_CREDENTIAL", ""),
	)

	if c.WebDir == "" {
		// Running from server/ in a checkout, serve a client that has been built.
		if info, err := os.Stat("../web/dist/index.html"); err == nil && !info.IsDir() {
			c.WebDir = "../web/dist"
		}
	}
	return c, nil
}

// iceServers groups STUN URLs into one entry and TURN URLs, with their
// credentials, into another, as RTCPeerConnection expects.
func iceServers(urls []string, username, credential string) []meeting.ICEServer {
	var stun, turn []string
	for _, u := range urls {
		if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
			turn = append(turn, u)
		} else {
			stun = append(stun, u)
		}
	}
	servers := []meeting.ICEServer{}
	if len(stun) > 0 {
		servers = append(servers, meeting.ICEServer{URLs: stun})
	}
	if len(turn) > 0 {
		servers = append(servers, meeting.ICEServer{URLs: turn, Username: username, Credential: credential})
	}
	return servers
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return strings.TrimSpace(v)
	}
	return fallback
}

func list(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func intEnv(key string, fallback int) (int, error) {
	raw := env(key, "")
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func boolEnv(key string, fallback bool) (bool, error) {
	raw := env(key, "")
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func durationEnv(key string, fallback time.Duration) (time.Duration, error) {
	raw := env(key, "")
	if raw == "" {
		return fallback, nil
	}
	v, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

// loadDotEnv sets variables from a KEY=VALUE file without overriding any that
// are already set.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(strings.TrimPrefix(key, "export "))
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if _, set := os.LookupEnv(key); !set {
			_ = os.Setenv(key, value)
		}
	}
}
