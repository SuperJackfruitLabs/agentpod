//go:build !unix

package superbench

import "os"

func registeredPipe(*os.File) (*os.File, error) { return nil, ErrRegisteredFrame }
