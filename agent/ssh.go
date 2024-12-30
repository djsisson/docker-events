package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"golang.org/x/crypto/ssh"
)

func sshmain() {

	// SSH connection details
	sshUser := "root"
	sshHost := "10.0.0.2"
	sshPort := "22"
	sshKeyPath := "/home/djsisson/.ssh/dj_rsa"

	// Load the SSH private key
	key, err := os.ReadFile(sshKeyPath)
	if err != nil {
		log.Fatalf("Unable to read private key: %v", err)
	}

	// Create the SSH signer
	signer, err := ssh.ParsePrivateKey(key)
	if err != nil {
		log.Fatalf("Unable to parse private key: %v", err)
	}

	// Configure the SSH client
	config := &ssh.ClientConfig{
		User: sshUser,
		Auth: []ssh.AuthMethod{
			ssh.PublicKeys(signer),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // Note: Replace this with a proper host key callback in production
	}

	// Connect to the SSH server
	sshClient, err := ssh.Dial("tcp", sshHost+":"+sshPort, config)
	if err != nil {
		log.Fatalf("Unable to connect to SSH server: %v", err)
	}
	defer sshClient.Close()

	// Create a local listener for the Docker API tunnel
	localListener, err := net.Listen("unix", "/tmp/docker.sock")
	if err != nil {
		log.Fatalf("Unable to create local listener: %v", err)
	}
	defer localListener.Close()

	var wg sync.WaitGroup
	shutdown := make(chan struct{})

	// Handle SIGINT and SIGTERM signals
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigs
		log.Println("Shutting down gracefully...")
		close(shutdown)
		localListener.Close()
		sshClient.Close()
		wg.Wait()
		log.Println("Shutdown complete.")
		os.Exit(0)
	}()

	// Start forwarding Docker API requests
	go func() {
		for {
			select {
			case <-shutdown:
				return
			default:
			}
			localConn, err := localListener.Accept()
			if err != nil {
				select {
				case <-shutdown:
					return
				default:
					log.Fatalf("Unable to accept connection: %v", err)
					continue
				}
			}

			remoteConn, err := sshClient.Dial("unix", "/var/run/docker.sock")
			if err != nil {
				log.Fatalf("Unable to connect to Docker API on remote host: %v", err)
				localConn.Close()
				continue
			}

			wg.Add(2)
			// Forward traffic between local and remote connections
			go func() {
				defer wg.Done()
				defer localConn.Close()
				defer remoteConn.Close()
				io.Copy(localConn, remoteConn)
			}()
			go func() {
				defer wg.Done()
				defer localConn.Close()
				defer remoteConn.Close()
				io.Copy(remoteConn, localConn)
			}()
		}
	}()

	// Wait for the tunnel to be established
	log.Println("SSH tunnel established. Connecting to Docker API...")

	// Connect to the Docker API through the tunnel
	cli, err := client.NewClientWithOpts(client.WithHost("unix:///tmp/docker.sock"), client.WithAPIVersionNegotiation())
	if err != nil {
		log.Fatalf("Error creating Docker client: %v", err)
	}

	ctx := context.Background()

	// Get list of running containers on the remote host
	containers, err := cli.ContainerList(ctx, container.ListOptions{})
	if err != nil {
		log.Fatalf("Error listing containers: %v", err)
	}

	for _, container := range containers {
		fmt.Printf("Container ID: %s, Name: %s, Image: %s\n", container.ID[0:12], container.Names[0][1:], container.Image)
	}

	// Wait for user input to exit
	select {}
}
