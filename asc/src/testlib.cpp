/*
 *  Copyright (c) Tien-Tsin Wong 1996
 *  All Right Reserved.
 *
 *  Adaptive Skeleton Climbing
 *
 *  Library testing sample.
 * 
 *  5 Sept 1996
 *
 */

#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <limits.h>
#include <memory.h>
#include "interface.h"
#include "vortex.h"
#include "initdata.h"


void main(int argc, char **argv)
{
  volume v;
  char mirafile[100];
  strcpy(mirafile,"craniomira128.12");

// Insert your read Mira file routine here
  if (!readMiraFile(&v, mirafile, 2, 0))
    fprintf(stderr, "[main]: cannot read MIRA file\n");

#ifdef ASCHEADER1
  asc1(&v, 50, "head-1.bin");
#elif  ASCHEADER2
  asc2(&v, 50, "head-2.bin");
#elif  ASCHEADER4
  asc4(&v, 50, "head-4.bin");
#elif  ASCHEADER8
  asc8(&v, 50, "head-8.bin");
#endif 
}



