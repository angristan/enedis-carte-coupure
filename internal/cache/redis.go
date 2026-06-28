package cache

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type JSONStore interface {
	Get(ctx context.Context, key string, destination any) (bool, error)
	Set(ctx context.Context, key string, value any) error
}

type TTLJSONStore interface {
	JSONStore
	SetTTL(ctx context.Context, key string, value any, ttl time.Duration) error
}

type RedisConfig struct {
	URL      string
	Addr     string
	Password string
	DB       int
}

type RedisJSONStore struct {
	client *redis.Client
	prefix string
}

func NewRedisClient(ctx context.Context, config RedisConfig) (*redis.Client, error) {
	var options *redis.Options
	if strings.TrimSpace(config.URL) != "" {
		parsed, err := redis.ParseURL(strings.TrimSpace(config.URL))
		if err != nil {
			return nil, err
		}
		options = parsed
	} else {
		options = &redis.Options{
			Addr:     strings.TrimSpace(config.Addr),
			Password: config.Password,
			DB:       config.DB,
		}
	}

	client := redis.NewClient(options)

	pingCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}

	return client, nil
}

func NewRedisJSONStore(client *redis.Client, prefix string) *RedisJSONStore {
	return &RedisJSONStore{
		client: client,
		prefix: strings.Trim(strings.TrimSpace(prefix), ":"),
	}
}

func (s *RedisJSONStore) Get(ctx context.Context, key string, destination any) (bool, error) {
	value, err := s.client.Get(ctx, s.key(key)).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal([]byte(value), destination); err != nil {
		return false, err
	}
	return true, nil
}

func (s *RedisJSONStore) Set(ctx context.Context, key string, value any) error {
	return s.SetTTL(ctx, key, value, 0)
}

func (s *RedisJSONStore) SetTTL(ctx context.Context, key string, value any, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, s.key(key), data, ttl).Err()
}

func (s *RedisJSONStore) key(key string) string {
	cleaned := strings.TrimSpace(key)
	if s.prefix == "" {
		return cleaned
	}
	return s.prefix + ":" + cleaned
}
