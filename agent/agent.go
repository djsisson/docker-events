package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/docker/docker/api/types"
	Container "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

type ContainerDetails struct {
	Id           string `json:"id"`
	Name         string `json:"name"`
	CPUUsage     string `json:"cpuUsage"`
	MemUsed      string `json:"memUsed"`
	MemAvailable string `json:"memAvailable"`
	MemUsage     string `json:"memUsage"`
	NetRead      string `json:"netRead"`
	NetWrite     string `json:"netWrite"`
	Pids         string `json:"pids"`
}

//var stats = make([]ContainerStats, 0, 60)

func getCli() (*client.Client, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		fmt.Println(err)
		return nil, err
	}
	return cli, nil
}

func ContainerList(cli *client.Client, all bool) []types.Container {
	containers, err := cli.ContainerList(context.Background(), Container.ListOptions{All: all})
	if err != nil {
		fmt.Println(err)
		return nil
	}
	return containers
}

func ContainerStats(cli *client.Client, container types.Container) ContainerDetails {
	resp, err := cli.ContainerStats(context.Background(), container.ID, false)
	if err != nil {
		fmt.Println(err)
		return ContainerDetails{}
	}
	defer resp.Body.Close()

	cntStats := Container.StatsResponse{}
	err = json.NewDecoder(resp.Body).Decode(&cntStats)
	if err != nil {
		fmt.Println(err)
		return ContainerDetails{}
	}

	stat := Container.Stats{}
	stat = cntStats.Stats
	netRead := uint64(0)
	netWrite := uint64(0)
	for _, netStat := range cntStats.Networks {
		// do something with netStat
		netRead += uint64(netStat.RxBytes)
		netWrite += uint64(netStat.TxBytes)
	}

	CPUDelta := stat.CPUStats.CPUUsage.TotalUsage - stat.PreCPUStats.CPUUsage.TotalUsage
	sysCPUDelta := stat.CPUStats.SystemUsage - stat.PreCPUStats.SystemUsage
	numCPUs := len(stat.CPUStats.CPUUsage.PercpuUsage)
	if numCPUs == 0 {
		numCPUs = int(stat.CPUStats.OnlineCPUs)
	}

	return ContainerDetails{
		Id:           container.ID[:12],
		Name:         strings.Join(container.Names, ",")[1:],
		CPUUsage:     fmt.Sprintf("%.2f", (float64(CPUDelta)/float64(sysCPUDelta)*float64(numCPUs))*100.0) + "%",
		MemUsed:      formatBytes(stat.MemoryStats.Usage),
		MemAvailable: formatBytes(stat.MemoryStats.Limit),
		MemUsage:     fmt.Sprintf("%.2f", (float64(stat.MemoryStats.Usage)/float64(stat.MemoryStats.Limit))*100.0) + "%",
		NetRead:      formatBytes(netRead),
		NetWrite:     formatBytes(netWrite),
		Pids:         fmt.Sprintf("%d", stat.PidsStats.Current),
	}

}

func formatBytes(bytes uint64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	} else if bytes < 1024*1024 {
		return fmt.Sprintf("%.2f KiB", float64(bytes)/1024)
	} else if bytes < 1024*1024*1024 {
		return fmt.Sprintf("%.2f MiB", float64(bytes)/1024/1024)
	} else {
		return fmt.Sprintf("%.2f GiB", float64(bytes)/1024/1024/1024)
	}
}
