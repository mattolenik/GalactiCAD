#ifndef __COMMON_H
#define __COMMON_H

#include <stdio.h>

#define MAX(a,b)		((a>b)? a : b)
#define MIN(a,b)		((a<b)? a : b)
#define ERREXIT(s)		{fprintf(stderr,s); exit(1);}
#define ERREXIT2(s1,s2) {fprintf(stderr,s1,s2); exit(1);}
#define ERRMSG(s)		{fprintf(stderr,s);}

#define FALSE  0
#define TRUE   1

#define FAIL   0
#define OKAY   1

// Flags for MapStat()
#define STAT_PROP_NO  6
#define STAT_MEAN     0
#define STAT_MEDIAN   1
#define STAT_MAX      2
#define STAT_MIN      3
#define STAT_VAR      4
#define STAT_SD       5


// Simple window coordinate calculation routines.
void SpanReorder(int *interval);
void WindowIntersect(int *xwin1, int *ywin1, int *xwin2,
		     int *ywin2, int *xout,  int *yout);

// Some utility routines to handle cross platform file issues
void   SingleSwapByte(unsigned char *buf, int nbytes);
void   SwapByte(unsigned char *buf, size_t elemsize, size_t nelem);
size_t cp_fread (void *buf, size_t size, size_t n, FILE* file);
size_t cp_fwrite(void *buf, size_t size, size_t n, FILE* file);
size_t pc_fread (void *buf, size_t size, size_t n, FILE* file);
size_t pc_fwrite(void *buf, size_t size, size_t n, FILE* file);
long   GetFileSize(FILE *fptr);


// Some utility routines to handle/analyze memory buffer
void   InvertBuf(unsigned char *buf, int h, long scansize);
float *FtMapStat(int w, int h, float *buf, char *statflag);


// Timing utilities
double CurrTime();

#endif

