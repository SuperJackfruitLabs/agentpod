//go:build !unix

package superbench

import (
	"context"
	"os"
)

func checkHermesConfig(HermesConfig) error                      { return ErrHermesConfig }
func readHermesInput(context.Context, *os.File) ([]byte, error) { return nil, ErrHermesInput }
