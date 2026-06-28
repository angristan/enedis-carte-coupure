package cache

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

type MemoryTTLJSONStore struct {
	mu      sync.RWMutex
	entries map[string]memoryEntry
}

type memoryEntry struct {
	data      []byte
	expiresAt time.Time
}

func NewMemoryTTLJSONStore() *MemoryTTLJSONStore {
	return &MemoryTTLJSONStore{entries: map[string]memoryEntry{}}
}

func (s *MemoryTTLJSONStore) Get(_ context.Context, key string, destination any) (bool, error) {
	now := time.Now()

	s.mu.RLock()
	entry, ok := s.entries[key]
	s.mu.RUnlock()
	if !ok {
		return false, nil
	}
	if !entry.expiresAt.IsZero() && now.After(entry.expiresAt) {
		s.mu.Lock()
		delete(s.entries, key)
		s.mu.Unlock()
		return false, nil
	}

	if err := json.Unmarshal(entry.data, destination); err != nil {
		return false, err
	}
	return true, nil
}

func (s *MemoryTTLJSONStore) Set(ctx context.Context, key string, value any) error {
	return s.SetTTL(ctx, key, value, 0)
}

func (s *MemoryTTLJSONStore) SetTTL(_ context.Context, key string, value any, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}

	entry := memoryEntry{data: data}
	if ttl > 0 {
		entry.expiresAt = time.Now().Add(ttl)
	}

	s.mu.Lock()
	s.entries[key] = entry
	s.mu.Unlock()
	return nil
}
