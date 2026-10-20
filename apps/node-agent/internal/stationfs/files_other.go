//go:build !linux

package stationfs

import "errors"

func execute(Request) (any, error) { return nil, errors.New("station files require Linux openat2") }
