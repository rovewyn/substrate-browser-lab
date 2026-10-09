// Demonstrate process memory continuity across an Actor snapshot and restore.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type state struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"started_at"`
	Token     string `json:"token"`
	Counter   int64  `json:"counter"`
}

func main() {
	// Generate once. No state is read from or written to application files.
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		log.Fatal(err)
	}
	current := state{PID: os.Getpid(), StartedAt: time.Now().UTC().Format(time.RFC3339Nano), Token: hex.EncodeToString(random)}
	var mu sync.Mutex
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/increment" {
			n := int64(1)
			if raw := r.URL.Query().Get("n"); raw != "" {
				value, err := strconv.ParseInt(raw, 10, 64)
				if err != nil || value < 1 || value > 1000000 {
					http.Error(w, "n must be between 1 and 1000000", http.StatusBadRequest)
					return
				}
				n = value
			}
			current.Counter += n
		} else if r.URL.Path != "/status" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(current)
	})
	log.Print("RAM demo listening on 127.0.0.1:8765")
	log.Fatal(http.ListenAndServe("127.0.0.1:8765", nil))
}
