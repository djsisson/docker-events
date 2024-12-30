package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	Container "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/client"
	"github.com/gorilla/websocket"
)

var startTag = time.Now().Unix()
var indexHtml = ""
var statsHtml = ""
var cli *client.Client

var (
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	mu       sync.Mutex
	cancelFn context.CancelFunc
)

func main() {

	file, err := os.ReadFile("./index.html")
	if err != nil {
		return
	}
	indexHtml = string(file)
	file, err = os.ReadFile("./stats.html")
	if err != nil {
		return
	}
	statsHtml = string(file)
	cli, err = getCli()
	if err != nil {
		fmt.Println(err)
		return
	}
	defer cli.Close()

	http.HandleFunc("/", getRoot)
	http.HandleFunc("/stats", getStats)
	http.HandleFunc("/containers", getContainers)
	http.HandleFunc("/containerstats", getContainerStats)
	http.HandleFunc("/ws", handleWebSocket)
	fmt.Println("starting server on port 8000")
	err = http.ListenAndServe(":8000", nil)
	if errors.Is(err, http.ErrServerClosed) {
		fmt.Printf("server closed\n")
	} else if err != nil {
		fmt.Printf("error starting server: %s\n", err)
		os.Exit(1)
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		fmt.Printf("error %s when upgrading connection to websocket", err)
		return
	}
	defer func() {
		fmt.Println("closing connection")
		c.Close()
	}()
	for {
		mt, message, err := c.ReadMessage()
		if err != nil {
			fmt.Printf("Error %s when reading message from client", err)
			return
		}
		if mt == websocket.BinaryMessage {
			err = c.WriteMessage(websocket.TextMessage, []byte("server doesn't support binary messages"))
			if err != nil {
				fmt.Printf("Error %s when sending message to client", err)
			}
			return
		}
		fmt.Printf("Receive message %s", string(message))
		var ctx context.Context
		mu.Lock()
		if cancelFn != nil {
			cancelFn()
		}
		if string(message) == "events" {
			ctx, cancelFn = context.WithCancel(context.Background())
		}
		mu.Unlock()
		switch expression := string(message); expression {
		case "stats":
			{
				var containerStats []ContainerDetails
				containers := ContainerList(cli, false)
				for _, container := range containers {
					containerStats = append(containerStats, ContainerStats(cli, container))
				}
				if len(containerStats) > 0 {
					err = c.WriteJSON(containerStats)
				}
				if err != nil {
					fmt.Println(err)
					return
				}
			}
		case "events":
			{
				go sendEvents(c, ctx)
			}
		default:
			{
				err = c.WriteMessage(websocket.TextMessage, []byte("unknown command"))
				if err != nil {
					fmt.Printf("Error %s when sending message to client", err)
					return
				}
			}
		}
	}
}

func sendEvents(c *websocket.Conn, ctx context.Context) {
	events, errs := cli.Events(ctx, events.ListOptions{})

	for {
		select {
		case <-ctx.Done():
			return
		case err := <-errs:
			if err != nil {
				fmt.Printf("Error: %s ", err)
				return
			}
		case event := <-events:
			c.WriteJSON(event)
		}
	}
}

func getContainers(w http.ResponseWriter, r *http.Request) {

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	containers, err := cli.ContainerList(context.Background(), Container.ListOptions{All: true})
	if err != nil {
		fmt.Println(err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	type containerInfo struct {
		Id   string
		Name string
	}
	var containerList []containerInfo
	for _, container := range containers {
		containerList = append(containerList, containerInfo{Id: container.ID[0:12], Name: container.Names[0][1:]})
	}

	jsonBytes, err := json.Marshal(containerList)
	if err != nil {
		fmt.Println(err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	io.Writer.Write(w, jsonBytes)

}

func getContainerStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	containers, err := cli.ContainerList(context.Background(), Container.ListOptions{})
	if err != nil {
		fmt.Println(err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	statsChan := make(chan ContainerDetails)
	var wg sync.WaitGroup
	var stats []ContainerDetails

	for _, container := range containers {
		wg.Add(1)
		go func(container types.Container) {
			defer wg.Done()
			statsChan <- ContainerStats(cli, container)
		}(container)
	}

	go func() {
		wg.Wait()
		close(statsChan)
	}()

	for stat := range statsChan {
		stats = append(stats, stat)
	}

	jsonBytes, err := json.Marshal(stats)
	if err != nil {
		fmt.Println(err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	io.Writer.Write(w, jsonBytes)
}

func getRoot(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Etag") == fmt.Sprintf("%d", startTag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Etag", fmt.Sprintf("%d", startTag))
	w.Header().Set("Content-Type", "text/html")
	io.WriteString(w, indexHtml)

}
func getStats(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Etag") == fmt.Sprintf("%d", startTag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Etag", fmt.Sprintf("%d", startTag))
	w.Header().Set("Content-Type", "text/html")
	io.WriteString(w, statsHtml)
}
